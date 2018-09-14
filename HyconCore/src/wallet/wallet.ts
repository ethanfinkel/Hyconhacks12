import * as bip39 from "bip39"
import blake2b = require("blake2b")
import * as crypto from "crypto"
import * as fs from "fs-extra"
import HDKey = require("hdkey")
import { getLogger } from "log4js"
import secp256k1 = require("secp256k1")
import { encodingMnemonic } from "../api/client/stringUtil"
import { Address } from "../common/address"
import { PrivateKey } from "../common/privateKey"
import { PublicKey } from "../common/publicKey"
import { Tx } from "../common/tx"
import { SignedTx } from "../common/txSigned"
import {
    CHINESE_SIMPLIFIED_WORDLIST,
    CHINESE_TRADITIONAL_WORDLIST,
    ENGLISH_WORDLIST,
    FRENCH_WORDLIST,
    ITALIAN_WORDLIST,
    JAPANESE_WORDLIST,
    KOREAN_WORDLIST,
    SPANISH_WORDLIST,
} from "./mnemonic"

const logger = getLogger("Wallet")

const coinNumber: number = 1397

export class Wallet {
    public static async walletInit(): Promise<undefined> {
        try {
            await fs.ensureDir("./wallet/rootKey")
        } catch (e) {
            try {
                await fs.mkdir("./wallet")
                await fs.mkdir("./wallet/rootKey")
            } catch (error) {
                logger.error(`Make Directory fail : ${error}`)
                return Promise.reject(error)
            }
        }
        return Promise.resolve(undefined)
    }

    public static randomWallet(): Wallet {
        const privateKey = new PrivateKey()
        return new Wallet(privateKey)
    }

    public static generate(wallet?: { name?: string, passphrase?: string, mnemonic: string, language?: string, hint?: string }): Wallet {
        if (wallet && wallet.mnemonic) {
            const language = wallet.language ? wallet.language : "english"
            return Wallet.generateKeyWithMnemonic(wallet.mnemonic, language.toLowerCase(), wallet.passphrase)
        } else {
            return Wallet.generateKeyWithMnemonic(Wallet.getRandomMnemonic("english"))
        }
    }

    public static generateHDWallet(wallet?: { name?: string, passphrase?: string, mnemonic: string, language?: string, hint?: string }): Wallet {
        if (wallet && wallet.mnemonic) {
            const language = wallet.language ? wallet.language : "english"
            return Wallet.generateHDWalletWithMnemonic(wallet.mnemonic, language.toLowerCase(), wallet.passphrase)
        } else {
            return Wallet.generateHDWalletWithMnemonic(Wallet.getRandomMnemonic("english"))
        }
    }

    public static validateMnemonic(mnemonic: string, language: string): boolean {
        return bip39.validateMnemonic(mnemonic, Wallet.getWordList(language))
    }

    public static generateKeyWithMnemonic(mnemonic: string, language: string = "english", passphrase?: string, index: number = 0): Wallet {
        const masterKey = Wallet.hdKeyFromMnemonic(mnemonic, language, passphrase)
        return Wallet.deriveWallet(masterKey.privateExtendedKey, index)
    }

    public static generateHDWalletWithMnemonic(mnemonic: string, language: string = "english", passphrase?: string, index: number = 0): Wallet {
        const masterKey = Wallet.hdKeyFromMnemonic(mnemonic, language, passphrase)
        return new Wallet(masterKey.privateExtendedKey)
    }

    public static checkPublicKey(publicKey: Buffer, privateKey: Buffer): boolean {
        let isEqual = true
        const secpPublicKey = secp256k1.publicKeyCreate(privateKey)
        if (publicKey.length !== secpPublicKey.length) {
            isEqual = false
        } else {
            for (let i = 0; i < publicKey.length; i++) {
                if (publicKey[i] !== secpPublicKey[i]) {
                    isEqual = false
                    break
                }
            }
        }
        return isEqual
    }
    public static getRandomMnemonic(language: string = "english"): string {
        return bip39.generateMnemonic(128, undefined, Wallet.getWordList(language))
    }

    public static getWordList(language: string): string[] {
        let returnWordList
        switch (language) {
            case "english":
                returnWordList = ENGLISH_WORDLIST
                break
            case "korean":
                returnWordList = KOREAN_WORDLIST
                break
            case "chinese_simplified":
                returnWordList = CHINESE_SIMPLIFIED_WORDLIST
                break
            case "chinese_traditional":
                returnWordList = CHINESE_TRADITIONAL_WORDLIST
                break
            case "chinese":
                throw new Error("Did you mean chinese_simplified or chinese_traditional?")
            case "japanese":
                returnWordList = JAPANESE_WORDLIST
                break
            case "french":
                returnWordList = FRENCH_WORDLIST
                break
            case "spanish":
                returnWordList = SPANISH_WORDLIST
                break
            case "italian":
                returnWordList = ITALIAN_WORDLIST
                break
            default:
                returnWordList = ENGLISH_WORDLIST
                break

        }
        return returnWordList
    }
    public static encryptAES(password: string, data: string): string {
        const iv = crypto.randomBytes(16)
        const key = blake2b(32).update(Buffer.from(password)).digest()
        const cipher = crypto.createCipheriv("aes-256-cbc", key, iv)
        const dataBuffer = Buffer.from(data)
        const encryptedData1 = cipher.update(dataBuffer)
        const encryptedData2 = cipher.final()
        const encryptedData = Buffer.concat([encryptedData1, encryptedData2])
        const encrtypedDataWithIV = iv.toString("hex") + ":" + encryptedData.toString("hex")
        return encrtypedDataWithIV
    }

    public static decryptAES(password: string, rawBufferData: Buffer): string {
        const rawData = rawBufferData.toString()
        const stringArray = rawData.split(":")
        if (stringArray.length !== 3) { throw new Error(`Fail to decryptAES`) }
        const iv = Buffer.from(stringArray[1], "hex")
        const encryptedData = Buffer.from(stringArray[2], "hex")
        const key = blake2b(32).update(Buffer.from(password)).digest()
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv)
        const originalData1 = decipher.update(encryptedData)
        const originalData2 = decipher.final()
        const originalData = Buffer.concat([originalData1, originalData2])
        return originalData.toString()
    }

    public static async getHint(name: string): Promise<string> {
        const rawData = await fs.readFile(`./wallet/rootKey/${name}`)
        const stringArr = rawData.toString().split(":")
        if (stringArr.length !== 3) { throw new Error(`Wallet did not save with hint`) }
        return rawData.toString().split(":")[0]
    }

    public static async loadKeys(name: string, password: string): Promise<Wallet> {
        try {
            const rawPrvKey = await fs.readFile(`./wallet/rootKey/${name}`)
            const decryptResult = Wallet.decryptAES(password, rawPrvKey)
            return new Wallet(Buffer.from(decryptResult, "hex"))
        } catch (e) {
            logger.error("Fail to loadKeys : " + e)
            return Promise.reject("Fail to loadKeys : " + e)
        }
    }

    public static async loadHDKeys(name: string, password: string, index: number = 0, count: number = 10): Promise<Wallet[]> {
        try {
            const rawRootKey = await fs.readFile(`./wallet/rootKey/${name}`)
            const decrypteResult = Wallet.decryptAES(password, rawRootKey)
            const walletList: Wallet[] = []
            for (let i = index; i < index + count; i++) {
                walletList.push(Wallet.deriveWallet(decrypteResult, i))
            }
            return walletList
        } catch (e) {
            logger.error("Fail to loadKeys : " + e)
            return Promise.reject("Fail to loadKeys : " + e)
        }
    }

    public static async getAddress(name: string): Promise<string> {
        try {
            const walletList = await Wallet.getAllPubliclist()
            for (const wallet of walletList) {
                let nameOfWallet = wallet.name
                if (nameOfWallet.charCodeAt(0) >= 0xAC00 && nameOfWallet.charCodeAt(0) <= 0xD7A3) {
                    nameOfWallet = encodingMnemonic(nameOfWallet)
                }
                if (name.charCodeAt(0) >= 0xAC00 && name.charCodeAt(0) <= 0xD7A3) {
                    name = encodingMnemonic(name)
                }
                if (nameOfWallet === name) {
                    return wallet.address
                }
            }
            return ""
        } catch (e) {
            logger.error("Fail to get AddressList")
            return Promise.reject("Fail to get AddressList")
        }
    }

    public static async recoverWallet(
        recoveryParamets: {
            name: string, passphrase: string, mnemonic: string, language: string, hint: string,
        },
        password: string): Promise<string> {
        try {
            if (await Wallet.checkDupleName(recoveryParamets.name)) {
                throw new Error("name")
            }
            const wallet = Wallet.generate(recoveryParamets)
            await wallet.save(recoveryParamets.name, password, recoveryParamets.hint)
            const addressString = await Wallet.getAddress(recoveryParamets.name)
            return addressString.toString()
        } catch (e) {
            throw new Error("failRecover")
        }
    }

    public static async recoverHDWallet(
        recoveryParamets: {
            name: string, passphrase: string, mnemonic: string, language: string, hint: string,
        },
        password: string): Promise<void> {
        try {
            if (await Wallet.checkDupleName(recoveryParamets.name)) {
                throw new Error("name")
            }
            const wallet = Wallet.generateHDWallet(recoveryParamets)
            await wallet.save(recoveryParamets.name, password, recoveryParamets.hint)
        } catch (e) {
            throw new Error("failRecover")
        }
    }

    public static async getAllPubliclist(): Promise<Array<{ name: string, address: string }>> {
        const listArray: Array<{ name: string, address: string }> = []
        try {
            await fs.ensureFile("./wallet/public")
            const fileData = await fs.readFile("./wallet/public")
            const walletList = fileData.toString().split(",")
            for (const wallet of walletList) {
                const stringTmp = wallet.split(":")
                if (stringTmp.length >= 2) {
                    listArray.push({ name: stringTmp[0], address: stringTmp[1] })
                }
            }
            return Promise.resolve(listArray)
        } catch (e) {
            logger.error(`Fail to getAllPubliclist : ${e}`)
            return Promise.reject(e)
        }
    }

    public static async walletList(idx?: number): Promise<{ walletList: Array<{ name: string, address: string }>, length: number }> {
        try {
            const keyList = await fs.readdir("./wallet/rootKey")
            const walletList: Array<{ name: string, address: string }> = []

            if (idx === undefined) {
                for (const rootKey of keyList) {
                    const address = await Wallet.getAddress(rootKey)
                    walletList.push({ name: rootKey, address: address.toString() })
                }
            } else {
                let length = (idx * 20) + 20
                length = length > keyList.length ? keyList.length : length
                for (let i = (idx * 20); i < length; ++i) {
                    const address = await Wallet.getAddress(keyList[i])
                    walletList.push({ name: keyList[i], address: address.toString() })
                }
            }

            return Promise.resolve({ walletList, length: keyList.length })
        } catch (e) {
            logger.error(`Fail to walletList : ${e}`)
            return Promise.reject(e)
        }
    }
    public static async delete(name: string): Promise<boolean> {
        try {
            if (await Wallet.checkDupleName(name)) {
                const walletList = await Wallet.getAllPubliclist()
                const writeList: string[] = []
                for (const wallet of walletList) {
                    if (wallet.name === name) {
                        continue
                    }
                    writeList.push(`${wallet.name}:${wallet.address},`)
                }
                await fs.unlink(`./wallet/rootKey/${name}`)
                await fs.writeFile("./wallet/public", writeList)
                return Promise.resolve(true)
            } else {
                logger.warn("Root key file not existed... ")
                return Promise.resolve(false)
            }
        } catch (e) {
            logger.error(`Fail to delete wallet : ${e}`)
            return Promise.reject(e)
        }
    }

    public static async checkDupleName(name: string): Promise<boolean> {
        return await fs.pathExists(`./wallet/rootKey/${name}`)
    }

    public static async getFavoriteList(): Promise<Array<{ alias: string, address: string }>> {
        const listArray: Array<{ alias: string, address: string }> = []
        try {
            await fs.ensureFile("./wallet/favorite")
            const fd = await fs.readFile("./wallet/favorite")
            const favoriteList = fd.toString().split(",")
            for (const favorite of favoriteList) {
                const data = favorite.split(":")
                if (data.length === 2) {
                    listArray.push({ alias: data[0], address: data[1] })
                }
            }
            return Promise.resolve(listArray)
        } catch (e) {
            logger.error(`Fail to getFavoriteList : ${e}`)
            return Promise.reject(e)
        }
    }

    public static async addFavorite(alias: string, address: string): Promise<boolean> {
        await fs.appendFile("./wallet/favorite", `${alias}:${address},`)
        return Promise.resolve(true)
    }

    public static async deleteFavorite(alias: string): Promise<boolean> {
        try {
            await fs.ensureFile("./wallet/favorite")
            const fd = await fs.readFile("./wallet/favorite")

            const favoriteList = fd.toString().split(",")
            for (const favorite of favoriteList) {
                const data = favorite.split(":")
                if (data[0] === alias) {
                    favoriteList.splice(favoriteList.indexOf(favorite), 1)
                    await fs.writeFile("./wallet/favorite", favoriteList.join(","))
                }
            }
            return Promise.resolve(true)
        } catch (e) {
            logger.error(`Fail to deleteFavorite : ${e}`)
            return Promise.reject(e)
        }
    }

    public static async addWalletFile(name: string, password: string, key: string): Promise<boolean> {
        try {
            const decrypteResult = Wallet.decryptAES(password, new Buffer(key))
            if (decrypteResult.slice(0, 4) === "xprv") {
                const wallet = new Wallet(decrypteResult)
            } else {
                const wallet = new Wallet(Buffer.from(decrypteResult, "hex"))
                if (!wallet.rootKey) { await Wallet.saveAddress(name, wallet.pubKey.address()) }
            }
            await fs.writeFile(`./wallet/rootKey/${name}`, key)
            return true
        } catch (e) {
            logger.error(`error : ${e}`)
            return false
        }
    }

    private static async saveAddress(name: string, address: Address) {
        try {
            await fs.ensureFile("./wallet/public")
            const originalData = await Wallet.getAllPubliclist()
            const dataArray: string[] = []

            originalData.push({ name, address: address.toString() })
            originalData.sort((a, b) => a.name.charCodeAt(0) - b.name.charCodeAt(0))
            for (const data of originalData) {
                dataArray.push(`${data.name}:${data.address}`)
            }
            await fs.writeFile("./wallet/public", dataArray)
        } catch (e) {
            logger.error(`Address file not exsited : ${e}`)
            throw e
        }
    }
    private static hdKeyFromMnemonic(mnemonic: string, language: string, passphrase: string): HDKey { // should private
        if (!Wallet.validateMnemonic(mnemonic, language)) {
            logger.error("invalid mnemonic or language in validateMnemonic()")
            throw new Error("mnemonic or language is invalid/mismatched")
        }

        const seed: Buffer = bip39.mnemonicToSeed(mnemonic, passphrase)
        const masterKey = HDKey.fromMasterSeed(seed)
        if (!masterKey.privateExtendedKey) {
            throw new Error("masterKey does not have Extended PrivateKey")
        }
        return masterKey
    }

    private static deriveWallet(extendPrvKey: string, index: number): Wallet { // should private
        const hdkey = HDKey.fromExtendedKey(extendPrvKey)
        const wallet = hdkey.derive(`m/44'/${coinNumber}'/0'/0/${index}`)
        if (!wallet.privateKey) {
            logger.error("Not much key information to save wallet")
            throw new Error("Not much key information to save wallet")
        }

        if (!secp256k1.privateKeyVerify(wallet.privateKey)) {
            logger.error("Fail to privateKeyVerify in generate Key with mnemonic")
            throw new Error("Fail to privateKeyVerify in generate Key with mnemonic")
        }

        if (!(Wallet.checkPublicKey(wallet.publicKey, wallet.privateKey))) {
            logger.error("publicKey from masterKey generated by hdkey is not equal publicKey generated by secp256k1")
            throw new Error("publicKey from masterKey generated by hdkey is not equal publicKey generated by secp256k1")
        }
        return new Wallet(wallet.privateKey, wallet.publicKey)
    }

    public readonly privKey: PrivateKey
    public readonly pubKey: PublicKey
    public readonly rootKey: string

    constructor(prvKey: (Buffer | PrivateKey | string), publicKeyBuffer?: Buffer) {
        if (prvKey instanceof Buffer || prvKey instanceof PrivateKey) {
            this.privKey = prvKey instanceof Buffer ? new PrivateKey(prvKey) : prvKey
            this.pubKey = (publicKeyBuffer === undefined) ? this.privKey.publicKey() : new PublicKey(publicKeyBuffer)
        } else {
            this.rootKey = prvKey
        }
    }

    public async save(name: string, password: string, hint?: string): Promise<void> {
        try {
            const walletExist = await Wallet.checkDupleName(name)
            if (walletExist) { throw new Error(`Wallet already exists : name=${name}`) }

            const key: string = this.rootKey ? this.rootKey : this.privKey.privKey.toString("hex")
            const encryptedPrivateKey = Wallet.encryptAES(password, key)
            let encPrivWithHint = ":" + encryptedPrivateKey
            if (hint !== undefined) {
                encPrivWithHint = hint + encPrivWithHint
            }
            await fs.writeFile(`./wallet/rootKey/${name}`, encPrivWithHint)

            if (!this.rootKey) { await Wallet.saveAddress(name, this.pubKey.address()) }
        } catch (e) {
            logger.error(`Fail to save wallet ${e}`)
            throw e
        }
    }

    public send(to: Address, amount: Long, nonce: number, fee?: Long): SignedTx {
        const from = this.pubKey.address()
        const tx = new Tx({ from, to, amount, fee, nonce })
        const stx = this.privKey.sign(tx)
        if (!(stx instanceof SignedTx)) {
            logger.error(`Sign method did not return SignedTx`)
            throw (new Error("sign method did not return SignedTx"))
        }
        return stx
    }

}
