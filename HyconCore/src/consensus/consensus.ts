import { EventEmitter } from "events"
import { getLogger } from "log4js"
import { Address } from "../common/address"
import { AsyncLock } from "../common/asyncLock"
import { AnyBlock, Block } from "../common/block"
import { GenesisBlock } from "../common/blockGenesis"
import { AnyBlockHeader, BlockHeader } from "../common/blockHeader"
import { DelayQueue } from "../common/delayQueue"
import { ITxPool } from "../common/itxPool"
import { SignedTx } from "../common/txSigned"
import { globalOptions } from "../main"
import { MinerServer } from "../miner/minerServer"
import { MAX_HEADER_SIZE } from "../network/rabbit/networkConstants"
import { Hash } from "../util/hash"
import { Account } from "./database/account"
import { Database } from "./database/database"
import { DBBlock } from "./database/dbblock"
import { DBMined } from "./database/dbMined"
import { DBTx } from "./database/dbtx"
import { ITxDatabase } from "./database/itxDatabase"
import { MinedDatabase } from "./database/minedDatabase"
import { TxDatabase } from "./database/txDatabase"
import { TxValidity, WorldState } from "./database/worldState"
import { DifficultyAdjuster } from "./difficultyAdjuster"
import { IConsensus, IStatusChange } from "./iconsensus"
import { BlockStatus } from "./sync"
import { Verify } from "./verify"
const logger = getLogger("Consensus")

const REBROADCAST_DIFFICULTY_TOLERANCE = 0.05
export const TIMESTAMP_TOLERANCE = 120000

export interface IPutResult {
    oldStatus: BlockStatus,
    status?: BlockStatus,
    dbBlock?: DBBlock,
}

export class Consensus extends EventEmitter implements IConsensus {
    private txdb?: ITxDatabase
    private minedDatabase: MinedDatabase
    private txPool: ITxPool
    private worldState: WorldState
    private db: Database
    private blockTip: DBBlock
    private headerTip: DBBlock
    private lock: AsyncLock
    private futureBlockQueue: DelayQueue

    private seenBlocksSet: Set<string> = new Set<string>()
    private seenBlocks: string[] = []
    private blockBroadcastLock: AsyncLock = new AsyncLock()
    private pendingBlocksPreviousMap: Map<string, Array<{ hash: string, block: Block }>>
    private pendingBlocksHashes: Set<string>
    private pendingBlocks: Array<{ hash: string, previousHash: string }>

    constructor(txPool: ITxPool, worldState: WorldState, dbPath: string, filePath: string, txPath?: string, minedDBPath?: string) {
        super()
        this.worldState = worldState
        this.txPool = txPool
        this.db = new Database(dbPath, filePath)
        if (txPath) { this.txdb = new TxDatabase(txPath) }
        if (minedDBPath) { this.minedDatabase = new MinedDatabase(minedDBPath) }
        this.futureBlockQueue = new DelayQueue(10)
        this.pendingBlocksPreviousMap = new Map<string, Array<{ hash: string, block: Block }>>()
        this.pendingBlocksHashes = new Set<string>()
        this.pendingBlocks = []
    }
    public async init(): Promise<void> {
        if (this.lock !== undefined) {
            throw new Error("Multiple calls to init")
        }
        this.lock = new AsyncLock(1)
        try {
            await this.db.init()
            this.blockTip = await this.db.getBlockTip()
            this.headerTip = await this.db.getHeaderTip()

            if (this.txdb !== undefined) {
                await this.txdb.init(this, this.blockTip === undefined ? undefined : this.blockTip.height)
            }
            if (this.minedDatabase !== undefined) {
                await this.minedDatabase.init(this, this.blockTip === undefined ? undefined : this.blockTip.height)
            }

            if (this.blockTip === undefined) {
                const genesis = await this.initGenesisBlock()
            }

            if (globalOptions.bootstrap !== undefined) {
                this.emit("candidate", this.blockTip, new Hash(this.blockTip.header))
            }

            logger.info(`Initialization of consensus is over.`)
            this.syncStatus()
        } catch (e) {
            logger.error(`Initialization failure in consensus: ${e}`)
            process.exit(1)
        } finally {
            this.lock.releaseLock()
        }
    }

    public async putBlock(block: Block, rebroadcast?: () => void, ip?: string): Promise<IStatusChange> {
        const status = await this.put(block.header, block, rebroadcast, ip)
        if (status.status === undefined || status.status < BlockStatus.Nothing) {
            return status
        }

        const hash = new Hash(block.header).toString()
        const previousHash = block.header.previousHash.toString()

        if (status.status < BlockStatus.Block && !this.pendingBlocksHashes.has(hash)) {
            logger.debug(`PENDING: Block(${hash}) pended due to status(${status.status})`)
            this.pendingBlocks.push({ hash, previousHash })
            this.pendingBlocksHashes.add(hash)
            const previousHashString = block.header.previousHash.toString()
            if (this.pendingBlocksPreviousMap.has(previousHashString)) {
                const pendings = this.pendingBlocksPreviousMap.get(previousHashString)
                pendings.push({ hash, block })
                logger.debug(`PENDING: Block(${hash}) appended to pendingBlocksPreviousMap(${pendings.length})`)
            } else {
                this.pendingBlocksPreviousMap.set(previousHashString, [{ hash, block }])
                logger.debug(`PENDING: Block(${hash}) created entry in pendingBlocksPreviousMap`)
            }

            while (this.pendingBlocks.length > 50) {
                const [old] = this.pendingBlocks.splice(0, 1)
                logger.debug(`PENDING: Removing old pending Block(${old.hash})`)
                this.pendingBlocksHashes.delete(old.hash)
                const pendings = this.pendingBlocksPreviousMap.get(old.previousHash)
                if (pendings !== undefined && pendings.length > 1) {
                    const newPendings = pendings.filter((pending) => pending.hash !== hash)
                    logger.debug(`PENDING: Filtering pending map(${pendings.length}) from Block(${old.previousHash}) to Block(${old.hash}), new length is ${newPendings.length} map size is ${this.pendingBlocksPreviousMap.size}`)
                    this.pendingBlocksPreviousMap.set(previousHash, newPendings)
                } else {
                    this.pendingBlocksPreviousMap.delete(previousHash)
                    logger.debug(`PENDING: Removing previousMap entry from Block(${old.previousHash}) to Block(${old.hash}), map size is ${this.pendingBlocksPreviousMap.size}`)

                }
            }
        }

        if (status.status >= BlockStatus.Block) {
            const pendings = this.pendingBlocksPreviousMap.get(hash)
            if (pendings !== undefined) {
                for (const pending of pendings) {
                    logger.debug(`PENDING: Will attempt to proccess Block(${pending.hash}) which was waiting for Block(${hash})`)
                    setImmediate(() => this.putBlock(pending.block))
                }
                this.pendingBlocksPreviousMap.delete(hash)
            }
        }

        return status
    }

    public putHeader(header: BlockHeader): Promise<IStatusChange> {
        return this.put(header)
    }

    public async putTxBlocks(txBlocks: Array<{ hash: Hash, txs: SignedTx[] }>) {
        const statusChanges: IStatusChange[] = []
        for (const txBlock of txBlocks) {
            const header = await this.getHeaderByHash(txBlock.hash)
            if (!(header instanceof BlockHeader)) { continue }
            const block = new Block({ header, txs: txBlock.txs })
            await this.upgradeHeaders(header)
            statusChanges.push(await this.putBlock(block))
        }
        try {
            if (this.headerTip.header instanceof BlockHeader) {
                await this.upgradeHeaders(this.headerTip.header)
            }
        } catch (e) {
            logger.debug(`Failed to upgrade to header tip: ${e}`)
        }
        return statusChanges
    }

    public async getBlockTxs(hash: Hash) {
        const block = (await this.getBlockByHash(hash))
        if (!(block instanceof Block)) {
            throw new Error(`Tried to get txs from genesis block`)
        }
        return { hash, txs: block.txs }
    }

    public getBlockByHash(hash: Hash): Promise<AnyBlock> {
        return this.db.getBlock(hash)
    }
    public async getHeaderByHash(hash: Hash): Promise<AnyBlockHeader | undefined> {
        const dbBlock = await this.db.getDBBlock(hash)
        if (dbBlock === undefined) { return undefined }
        return dbBlock.header
    }
    public async getBlocksRange(fromHeight: number, count?: number): Promise<AnyBlock[]> {
        try {
            if (count === undefined) {
                this.blockTip.height >= fromHeight ? count = this.blockTip.height - fromHeight + 1 : count = 0
            }
            const blocks: Block[] = []
            const dbblocks = await this.db.getDBBlocksRange(fromHeight, count)
            for (const dbblock of dbblocks) {
                const block = await this.db.dbBlockToBlock(dbblock)
                if (block instanceof Block) {
                    blocks.push(block)
                }
            }
            return blocks
        } catch (e) {
            logger.error(`getBlocksRange failed\n${e}`)
            throw e
        }

    }
    public async getHeadersRange(fromHeight: number, count?: number): Promise<AnyBlockHeader[]> {
        try {
            if (count === undefined) {
                this.headerTip.height >= fromHeight ? count = this.headerTip.height - fromHeight + 1 : count = 0
            }
            const dbblocks = await this.db.getDBBlocksRange(fromHeight, count)
            return dbblocks.map((dbblock) => dbblock.header)
        } catch (e) {
            logger.error(`getHeadersRange failed\n${e}`)
            throw e
        }
    }
    public getAccount(address: Address): Promise<Account> {
        if (this.blockTip === undefined) {
            throw new Error(`There is not any tips`)
        }
        return this.worldState.getAccount(this.blockTip.header.stateRoot, address)
    }
    public getLastTxs(address: Address, count?: number): Promise<DBTx[]> {
        if (this.txdb === undefined) {
            throw new Error(`The database to get txs does not exist.`)
        }
        const result: DBTx[] = []
        const idx: number = 0
        return this.txdb.getLastTxs(address, result, idx, count)
    }

    public getTxsInBlock(blockHash: string, count?: number): Promise<{ txs: DBTx[], amount: string, fee: string, length: number }> {
        if (this.txdb === undefined) {
            throw new Error(`The database to get txs does not exist.`)
        }
        const result: DBTx[] = []
        const idx: number = 0
        return this.txdb.getTxsInBlock(blockHash, result, idx, count)
    }

    public async getNextTxs(address: Address, txHash: Hash, index: number, count?: number): Promise<DBTx[]> {
        try {
            if (this.txdb) {
                const result: DBTx[] = []
                return await this.txdb.getNextTxs(address, txHash, result, index, count)
            } else {
                return Promise.reject(`The database to get txs does not exist.`)
            }
        } catch (e) {
            logger.error(`Fail to getNextTxs : ${e}`)
            return e
        }
    }

    public async getNextTxsInBlock(blockHash: string, txHash: string, index: number, count?: number): Promise<DBTx[]> {
        try {
            if (this.txdb) {
                const result: DBTx[] = []
                return await this.txdb.getNextTxsInBlock(blockHash, txHash, result, index, count)
            } else {
                return Promise.reject(`The database to get txs does not exist.`)
            }
        } catch (e) {
            logger.error(`Fail to getNextTxs : ${e}`)
            return e
        }
    }

    public async getMinedBlocks(address: Address, count?: number, index?: number, blockHash?: Hash): Promise<DBMined[]> {
        try {
            if (index === undefined) { index = 0 }
            if (count === undefined) { count = 10 }
            if (this.minedDatabase) {
                return this.minedDatabase.getMinedBlocks(address, count, index, blockHash)
            } else {
                return Promise.reject(`There is  no minedDatabase`)
            }
        } catch (e) {
            logger.error(`Fail to getMinedBlocks in consensus: ${e}`)
            return e
        }

    }
    public getBlockStatus(hash?: Hash): Promise<BlockStatus> {
        if (hash === undefined) {
            return Promise.resolve(BlockStatus.Nothing)
        }
        return this.db.getBlockStatus(hash)
    }

    public getBlocksTip(): { hash: Hash; height: number, totalwork: number } {
        return { hash: new Hash(this.blockTip.header), height: this.blockTip.height, totalwork: this.blockTip.totalWork }
    }

    public getCurrentDiff(): number {
        return this.blockTip.header.difficulty
    }
    public getHeadersTip(): { hash: Hash; height: number, totalwork: number } {
        return { hash: new Hash(this.headerTip.header), height: this.headerTip.height, totalwork: this.headerTip.totalWork }
    }

    public getHtip() {
        return this.headerTip
    }

    public getBtip() {
        return this.blockTip
    }

    public async txValidity(tx: SignedTx): Promise<TxValidity> {
        return this.lock.critical(async () => {
            let validity = await this.worldState.validateTx(this.blockTip.header.stateRoot, tx)
            if (!tx.verify()) { validity = TxValidity.Invalid }
            return validity
        })
    }
    public async getTx(hash: Hash): Promise<{ tx: DBTx, confirmation: number } | undefined> {
        if (this.txdb === undefined) {
            throw new Error(`The database to get txs does not exist.`)
        }
        return this.txdb.getTx(hash)
    }
    public getHash(height: number): Promise<Hash | undefined> {
        return this.db.getHashAtHeight(height)
    }
    public async getBlockHeight(hash: Hash): Promise<number> {
        const block = await this.db.getDBBlock(hash)
        return (block !== undefined) ? block.height : undefined
    }

    public async getBlockAtHeight(height: number): Promise<Block | GenesisBlock | undefined> {
        return this.db.getBlockAtHeight(height)
    }

    public async getBurnAmount(): Promise<{ amount: Long }> {
        return this.txdb.getBurnAmount()
    }
    private async put(header: BlockHeader, block?: Block, rebroadcast?: () => void, ip?: string): Promise<IStatusChange> {
        const hash = new Hash(header)
        if (header.merkleRoot.equals(Hash.emptyHash)) {
            // Block contains no transactions, create a new empty block
            block = new Block({ header, txs: [] })
        }

        if (block !== undefined) {
            if (await this.blockBroadcastCondition(block, hash)) {
                if (rebroadcast === undefined) {
                    this.emit("blockBroadcast", block)
                    logger.info(`Broadcasting Block(${new Hash(block.header).toString()})`)
                } else {
                    rebroadcast()
                    logger.info(`Rebroadcasting Block(${new Hash(block.header).toString()}) from ${ip}`)
                }
            }
        }

        if (header.timeStamp > Date.now() + TIMESTAMP_TOLERANCE) {
            if (this.futureBlockQueue.size() >= 10) {
                logger.warn(`Please check your system clock`)
            }
            await this.futureBlockQueue.waitUntil(header.timeStamp - TIMESTAMP_TOLERANCE)
        }

        return this.lock.critical(async () => {
            const { oldStatus, status, dbBlock } = await this.process(hash, header, block)

            if (status !== undefined && oldStatus !== status) {
                await this.db.setBlockStatus(hash, status)
            }

            if (dbBlock === undefined || status < BlockStatus.Header) {
                return { oldStatus, status }
            }

            await this.db.putDBBlock(hash, dbBlock)

            if (this.headerTip === undefined || (this.forkChoice(dbBlock, this.headerTip))) {
                this.headerTip = dbBlock
                await this.db.setHeaderTip(hash)
            }

            const timeDelta = Date.now() - header.timeStamp
            if (status < BlockStatus.Block) {
                if (timeDelta < TIMESTAMP_TOLERANCE) {
                    logger.info(`Processed ${block !== undefined ? "BHeader" : "Header "}`
                        + ` ${hash}\t(${dbBlock.height}, ${dbBlock.totalWork.toExponential(3)}),`
                        + `\tBTip(${this.blockTip.height}, ${this.blockTip.totalWork.toExponential(3)}),`
                        + `\tHTip(${this.headerTip.height}, ${this.headerTip.totalWork.toExponential(3)})`)
                }
                return { oldStatus, status, height: dbBlock.height }
            }

            if (block !== undefined && (this.blockTip === undefined || this.forkChoice(dbBlock, this.blockTip))) {
                await this.reorganize(hash, block, dbBlock)
                await this.db.setBlockTip(hash)
                this.emit("candidate", this.blockTip, hash)
            }

            if (timeDelta < TIMESTAMP_TOLERANCE) {
                logger.info(`Processed Block   `
                    + ` ${hash}\t(${dbBlock.height}, ${dbBlock.totalWork.toExponential(3)}),`
                    + `\tBTip(${this.blockTip.height}, ${this.blockTip.totalWork.toExponential(3)}),`
                    + `\tHTip(${this.headerTip.height}, ${this.headerTip.totalWork.toExponential(3)})`)
            }

            return { oldStatus, status, height: dbBlock.height }
        })
    }
    private async process(hash: Hash, header: BlockHeader, block?: Block): Promise<IPutResult> {
        // Consensus Critical
        const result: IPutResult = { oldStatus: await this.db.getBlockStatus(hash) }
        result.status = result.oldStatus

        if (result.oldStatus === BlockStatus.Rejected) {
            return result
        }

        if (header.previousHash.length <= 0) {
            logger.warn(`Rejecting block(${hash.toString()}): No previousHash`)
            result.status = BlockStatus.Rejected
            return result
        }

        const previousHash = header.previousHash[0]
        const previousStatus = await this.db.getBlockStatus(previousHash)

        if (previousStatus <= BlockStatus.Nothing) {
            return result
        }

        const previousDBBlock = await this.db.getDBBlock(previousHash)
        if (previousDBBlock === undefined) {
            return result
        }

        if (result.oldStatus === BlockStatus.Nothing) {
            await Verify.processHeader(previousDBBlock, header, hash, result)

            if (result.status === BlockStatus.Rejected) {
                return result
            }
        }

        if (block === undefined) {
            return result
        }

        if (previousStatus < BlockStatus.Block) {
            return result
        }

        if (result.oldStatus >= BlockStatus.Nothing && result.oldStatus <= BlockStatus.Header) {
            const dbBlock = (result.dbBlock !== undefined) ? result.dbBlock : await this.db.getDBBlock(hash)
            await Verify.processBlock(block, dbBlock, hash, header, previousDBBlock, this.db, this.worldState, result)
            if (result.status === BlockStatus.Rejected) {
                return result
            }

            if (this.minedDatabase !== undefined) {
                this.minedDatabase.putMinedBlock(hash, block.header.timeStamp, block.txs, block.header.miner)
            }
        }

        return result

    }

    private async reorganize(newBlockHash: Hash, newBlock: Block, newDBBlock: DBBlock) {
        // Consensus Critical
        const newBlockHashes: Hash[] = []
        const newBlocks: Block[] = []
        let popStopHeight = newDBBlock.height
        let hash = newBlockHash
        let block: Block = newBlock
        while (popStopHeight > 0) {
            newBlockHashes.push(hash)
            newBlocks.push(block)

            hash = block.header.previousHash[0]
            if (await this.db.getBlockStatus(hash) === BlockStatus.MainChain) {
                break
            }
            const tmpBlock = await this.db.getBlock(hash)
            if (!(tmpBlock instanceof Block)) {
                throw new Error("Error trying to reorganize past the genesis block")
            }
            block = tmpBlock
            popStopHeight -= 1
        }
        let popHeight = this.blockTip.height
        let popHash = new Hash(this.blockTip.header)
        const popCount = popHeight - popStopHeight + 1
        if (popCount >= 1) {
            logger.info(`Reorganizing, removing ${popCount} blocks for ${newBlocks.length} new blocks on a longer chain, `
                + `new tip ${newBlockHash.toString()}(${newDBBlock.height}, ${newDBBlock.totalWork.toExponential()}), `
                + `previous tip ${popHash.toString()}(${popHeight}, ${this.blockTip.totalWork.toExponential()}`)
        }

        const popTxs: SignedTx[] = []
        while (popHeight >= popStopHeight) {
            const popBlock = await this.db.getBlock(popHash)
            if (!(popBlock instanceof Block)) {
                throw new Error("Error trying to reorganize past the genesis block")
            }
            await this.db.setBlockStatus(popHash, BlockStatus.Block)
            this.emit("txs", popBlock.txs)
            for (const one of popBlock.txs) {
                popTxs.push(one)
            }
            popHash = popBlock.header.previousHash[0]
            popHeight -= 1
        }

        if (newBlocks.length !== newBlockHashes.length) {
            throw new Error("Error during reorganization")
        }

        let pushHeight = popStopHeight
        const removeTxs: SignedTx[] = []
        while (newBlockHashes.length > 0) {
            hash = newBlockHashes.pop()
            block = newBlocks.pop()
            await this.db.setBlockStatus(hash, BlockStatus.MainChain)
            await this.db.setHashAtHeight(pushHeight, hash)
            for (const tx of block.txs) {
                removeTxs.push(tx)
            }
            pushHeight += 1
            if (this.txdb) { await this.txdb.putTxs(hash, block.header.timeStamp, block.txs) }
            this.emit("block", block)
        }

        this.blockTip = newDBBlock
        // This must not use await because of lock. So we used then.
        this.txPool.putTxs(popTxs).then(() => this.txPool.removeTxs(removeTxs))
    }

    private async upgradeHeaders(header: BlockHeader) {
        logger.debug(`Upgrading headers up to hash: ${new Hash(header).toString()}`)
        const upgradeQueue: BlockHeader[] = []
        const maxLength = Math.floor((100 * 1024 * 1024) / MAX_HEADER_SIZE) // 100MB of headers
        let status: BlockStatus
        const results: IStatusChange[] = []
        do {
            status = await this.getBlockStatus(header.previousHash[0])
            if (status >= BlockStatus.Block) { break }
            logger.debug(header.previousHash[0].toString())
            const previousHeader = await this.getHeaderByHash(header.previousHash[0])
            if (!(previousHeader instanceof BlockHeader)) {
                // Header is genesis header
                break
            }
            if (!previousHeader.merkleRoot.equals(Hash.emptyHash)) {
                throw new Error(`Header merkleRoot is not empty`)
            }
            header = previousHeader
            upgradeQueue.push(header)
            if (upgradeQueue.length > maxLength) {
                upgradeQueue.shift()
            }
        } while (status < BlockStatus.Block)
        upgradeQueue.reverse()
        for (const blockHeader of upgradeQueue) {
            results.push(await this.putHeader(blockHeader))
        }
        return results
    }

    private forkChoice(newDBBlock: DBBlock, tip: DBBlock): boolean {
        return newDBBlock.totalWork > tip.totalWork
    }

    private async initGenesisBlock(): Promise<GenesisBlock> {
        try {
            const genesis = GenesisBlock.loadFromFile()
            const transition = await this.worldState.first(genesis)
            await this.worldState.putPending(transition.batch, transition.mapAccount)
            genesis.header.merkleRoot = new Hash("Centralization is the root of tyranny.")
            const genesisHash = new Hash(genesis.header)
            const { fileNumber, length, filePosition, offset } = await this.db.writeBlock(genesis)
            const dbBlock = new DBBlock({ fileNumber, header: genesis.header, height: 0, length, offset, tEMA: DifficultyAdjuster.getTargetTime(), pEMA: Math.pow(2, -10), totalWork: 0, nextDifficulty: Math.pow(2, -10) })
            await this.db.putDBBlock(genesisHash, dbBlock)
            this.blockTip = this.headerTip = dbBlock
            await this.db.setBlockStatus(genesisHash, BlockStatus.MainChain)
            await this.db.setHashAtHeight(0, genesisHash)
            await this.db.setHeaderTip(genesisHash)
            await this.db.setBlockTip(genesisHash)
            if (this.txdb) {
                await this.txdb.putTxs(genesisHash, genesis.header.timeStamp, genesis.txs)
            }
            return genesis
        } catch (e) {
            logger.error(`Fail to initGenesisBlock : ${e}`)
            throw e
        }
    }

    private async blockBroadcastCondition(block: Block, hash: Hash) {
        const hashString = hash.toString()
        return this.blockBroadcastLock.critical(async () => {
            const timeDelta = Math.abs(block.header.timeStamp - Date.now())
            if (timeDelta > TIMESTAMP_TOLERANCE) {
                return false
            }
            if (this.seenBlocksSet.has(hashString)) {
                return false
            }

            const merkleRoot = Block.calculateMerkleRoot(block.txs)
            if (!block.header.merkleRoot.equals(merkleRoot)) {
                return false
            }

            const status = await this.getBlockStatus(hash)
            if (status < BlockStatus.Nothing || status >= BlockStatus.Block) {
                return false
            }

            const proximalDifficulty = this.getHtip().header.difficulty * (1 + REBROADCAST_DIFFICULTY_TOLERANCE)
            const prehash = block.header.preHash()
            if (!MinerServer.checkNonce(prehash, block.header.nonce, proximalDifficulty)) {
                return false
            }

            this.seenBlocksSet.add(hashString)
            if (this.seenBlocks.length > 1000) {
                const [old] = this.seenBlocks.splice(0, 1)
                this.seenBlocksSet.delete(old)
            }
            this.seenBlocks.push(hashString)

            return true
        })
    }

    private syncStatus() {
        const epoch = 1527844585699
        const now = Date.now()
        const duration = now - epoch

        if (this.headerTip.header.timeStamp > now + TIMESTAMP_TOLERANCE || now < epoch) {
            logger.warn(`Please check your system clock`)
        }
        if (this.blockTip.header.timeStamp < now - 1000 * 60 * 5) {
            const blockDelta = Math.max(this.blockTip.header.timeStamp - epoch, 0)
            const blockProgress = 100 * blockDelta / duration
            const blockRemaining = Math.round((now - this.blockTip.header.timeStamp) / DifficultyAdjuster.getTargetTime())

            logger.info(`Syncing blocks  ${blockProgress.toFixed(3)}% complete approximately ${blockRemaining} remaining`)
        }

        if (this.headerTip.header.timeStamp < now - 1000 * 60 * 5) {
            const headerDelta = Math.max(this.headerTip.header.timeStamp - epoch, 0)
            const headerProgress = 100 * headerDelta / duration
            const headersRemaining = Math.round((now - this.headerTip.header.timeStamp) / DifficultyAdjuster.getTargetTime())

            logger.info(`Syncing headers ${headerProgress.toFixed(3)}% complete approximately ${headersRemaining} remaining`)
        }
        setTimeout(() => this.syncStatus(), 10000)
    }

}
