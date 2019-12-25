import { Instance, SnapshotOut, types, flow, getParentOfType, getEnv } from "mobx-state-tree"
import { GetPriceResult } from "../../services/coinbase"
import { CurrencyType } from "./CurrencyType"
import { AccountType } from "../../screens/accounts-screen/AccountType"
import { parseDate } from "../../utils/date"
import KeychainAction from "../../utils/keychain"
import { generateSecureRandom } from 'react-native-securerandom';

import functions from '@react-native-firebase/functions';
import firestore from '@react-native-firebase/firestore';

functions().useFunctionsEmulator('http://localhost:5000') // FIXME where to define this properly?

export const AuthModel = types
    .model("Auth", {
        email: "nicolas.burtey+default@gmail.com",
        isAnonymous: false,
        uid: "", 
        emailVerified: false
    })
    .actions(self => {
        const set = (email: string, emailVerified: boolean, isAnonymous: boolean, uid: string) => {
            self.email = email
            self.emailVerified = emailVerified
            self.isAnonymous = isAnonymous
            self.uid = uid
        }

        const setEmail = (email: string) => {
            self.email = email
        }

        return { set, setEmail }
    })

export const TransactionModel = types
    .model ("Transaction", {
        name: types.string,
        icon: types.string,
        amount: types.number,
        date: types.Date,
        cashback: types.maybe(types.number),
        addr: types.maybe(types.string), // TODO derived 2 types of transactions for fiat/crytpo?
        // TODO add status
    })

export const BaseAccountModel = types
    .model ("Account", {
        transactions: types.array(TransactionModel),
        confirmedBalance: 0,
        unconfirmedBalance: 0,
        type: types.enumeration<AccountType>("Account Type", Object.values(AccountType))
    })
    .views(self => ({
        get balance() {
            return self.confirmedBalance + self.unconfirmedBalance
        },
    }))

export const QuoteModel = types
.model("Quote", {
    satAmount: types.number,
    satPrice: types.number,
    validUntil: types.Date,
    signature: ""
})
.actions(self => {

    const quoteBTC = flow(function*() { 
        try {
            var result = yield functions().httpsCallable('quoteBTC')({
                satAmount: 10000
            })
            console.tron.log('result QuoteBTC', result)

            self.satAmount = result.satAmount
            self.satPrice = result.satAmount
            self.validUntil = result.satAmount
            self.signature = result.signature

            // 1 liner possible:
            // self == result ?
            // self .. {{ ... result }} ?

        } catch(err) {
            console.tron.log(err);
        }
    })

    const buyBTC = flow(function*() { 
        try {

            if (self.quote.validUntil > Date.now()) {
                return 'quote expired'
            }

            var result = yield functions().httpsCallable('buyBTC')({
                quote: self.quote,
                btcAddress: getParentOfType(self, DataStoreModel).lnd.onChainAddress,
            })
            console.tron.log('result BuyBTC', result)
        } catch(err) {
            console.tron.log(err);
        }
    })

    return { update }
})

export const FiatAccountModel = BaseAccountModel
    .props ({
        type: AccountType.Checking,
    })
    .actions(self => {
        const update_transactions = flow(function*() {
            const uid = getParentOfType(self, DataStoreModel).auth.uid
            try {
                const doc = yield firestore().collection('users').doc(uid).get()
                self.transactions = doc.data().transactions // TODO better error management
            } catch(err) {
                console.tron.warn(err)
            }
        })

        const update_balance = flow(function*() { 
            try {
                var result = yield functions().httpsCallable('getFiatBalances')({})
                console.tron.log('balance', result)
                if ("data" in result) {
                    self.confirmedBalance = result.data
                    // TODO: add unconfirmed balance
                }
            } catch(err) {
                console.tron.log(err);
            }
        })

        const reset = () => { // TODO test
            self.transactions.length = 0,
            self.confirmedBalance = 0
        }

        return  { update_balance, reset, update_transactions }
    })
    .views(self => ({
        get currency() {
            return CurrencyType.USD
        },
    }))


export const LndModel = BaseAccountModel
    .named("Lnd")
    .props ({
        walletExist: false,
        walletUnlocked: false,
        onChainAddress: "",
        type: AccountType.Bitcoin,
        pubkey: "",
        syncedToChain: false,
        blockHeight: 0,
    })
    .actions(self => {

        // stateless, but must be an action instead of a view because of the async call
        const initState = flow(function*() {
            const WALLET_EXIST = "rpc error: code = Unknown desc = wallet already exists"
            const CLOSED = "Closed"
            let walletExist = false
            try {
                yield getEnv(self).lnd.grpc.sendUnlockerCommand('GenSeed');
            } catch (err) {
                console.tron.log('wallet exist', err)
                if (err.message === WALLET_EXIST) {
                    walletExist = true
                }
                if (err.message === CLOSED) {
                    // We assumed that if sendUnlockerCommand is locked, the node is already launched.
                    // FIXME validate this assumption
                    walletExist = true
                    walletGotOpened()
                }
            }
            
            self.walletExist = walletExist
        })

        const genSeed = flow(function*() {
            try {
                const seed = yield getEnv(self).lnd.grpc.sendUnlockerCommand('GenSeed');
                console.tron.log("seed", seed.cipherSeedMnemonic)
                yield new KeychainAction().setItem('seed', seed.cipherSeedMnemonic.join(" "))    
            } catch (err) {
                console.tron.error(err)
            }
        })

        const initWallet = flow(function*() {

            function toHexString(byteArray) {
                return Array.from(byteArray, function(byte: any) {
                  return ('0' + (byte & 0xFF).toString(16)).slice(-2);
                }).join('')
              }

            const random_number = yield generateSecureRandom(24)
            const wallet_password = toHexString(random_number)

            try {
                yield getEnv(self).lnd.grpc.sendUnlockerCommand('InitWallet', {
                    walletPassword: Buffer.from(wallet_password, 'hex'),
                    cipherSeedMnemonic: (yield new KeychainAction().getItem('seed')).split(" "),
                })
                
                yield new KeychainAction().setItem('password', wallet_password)

                self.walletUnlocked = true;
                self.walletExist = true;
            } catch (err) {
                console.tron.error(err)
            }
        })

        // this get triggered after the wallet is being unlocked
        const walletGotOpened = flow(function*() {
            self.walletUnlocked = true
            const nodeinfo = yield getEnv(self).lnd.grpc.sendCommand('GetInfo')
            self.pubkey = nodeinfo.identityPubkey
            self.blockHeight = nodeinfo.blockHeight
            self.syncedToChain = nodeinfo.syncedToChain
            newAddress()
            update_transactions()
            update_balance()
        })

        const unlockWallet = flow(function*() {
            // TODO: auth with biometrics/passcode
            const wallet_password = yield new KeychainAction().getItem('password')

            try {
                yield getEnv(self).lnd.grpc.sendUnlockerCommand('UnlockWallet', {
                    walletPassword: Buffer.from(wallet_password, 'hex'),
                })

                yield walletGotOpened()
            } catch (err) {
                console.tron.error(err)
            }
        })
         
        const newAddress = flow(function*() {
            const { address } = yield getEnv(self).lnd.grpc.sendCommand('NewAddress', {type: 0})
            self.onChainAddress = address
            console.tron.log(address)
        })

        const update_transactions = flow(function*() {
            try {
              const { transactions } = yield getEnv(self).lnd.grpc.sendCommand('getTransactions');
              console.tron.log('raw tx: ', transactions)

              const txs = transactions.map(transaction => ({
                id: transaction.txHash,
                type: 'bitcoin',
                amount: transaction.amount,
                fee: transaction.totalFees,
                confirmations: transaction.numConfirmations,
                status: transaction.numConfirmations < 3 ? 'unconfirmed' : 'confirmed',
                date: parseDate(transaction.timeStamp),
                moneyIn: transaction.amount > 0, // FIXME verify is this works like this for lnd
              }));
              console.tron.log('tx: ', txs)

              self.transactions = txs.map(tx => ({
                    name: tx.moneyIn? "Received" : "Sent",
                    icon: tx.moneyIn? "ios-download" : "ios-exit",
                    amount: tx.amount,
                    date: tx.date,

                    //   tx.moneyIn ? 
                    //   tx.addr = tx.inputs[0].prev_out.addr : // show input (the other address) if money comes in
                    //   tx.addr = tx.out[0].addr
                    //   tx.addr_fmt = `${tx.addr.slice(0, 11)}...${tx.addr.slice(-10)}`
                    //   tx.addr = tx.addr_fmt // TODO FIXME better naming 

                    // FIXME: this is tx hash, use address instead
                    addr: `${tx.id.slice(0, 11)}...${tx.id.slice(-10)}`,
              }))

            } catch (err) {
              console.tron.error('Listing transactions failed', err);
            }
          })

          const update_balance = flow(function*() {
            try {
                const r = yield getEnv(self).lnd.grpc.sendCommand('WalletBalance');
                self.confirmedBalance = r.confirmedBalance;
                self.unconfirmedBalance = r.unconfirmedBalance;
              } catch (err) {
                console.tron.error('Getting wallet balance failed', err);
              }
          })

          const send_transaction = flow(function*(addr, amount) {
            yield getEnv(self).lnd.grpc.sendCommand('sendCoins', {addr, amount});
          })

        return  { 
            initState,
            genSeed,
            initWallet, 
            unlockWallet, 
            walletGotOpened,
            newAddress, 
            update_transactions,
            update_balance,
            send_transaction,
        }
    
    })
    .views(self => ({
        get currency() {
            return CurrencyType.BTC
        }
    }))


export const AccountModel = types.union(FiatAccountModel, LndModel)


export const RatesModel = types
    .model("Rates", {
        USD: 1,  // TODO is there a way to have enum as parameter?
        BTC: 0.0001, // Satoshi to USD default value
    })
    .actions(self => {
        const update = flow(function*() {
            const result: GetPriceResult = yield getEnv(self).api.getPrice()
            if ("price" in result) {
                self.BTC = result.price
            } else {
                console.tron.warn("issue with price API")
                // TODO error management
            }
        })
        return  { update }
    })


export const DataStoreModel = types
    .model("DataStore", {
        auth: types.optional(AuthModel, {}),
        fiat: types.optional(FiatAccountModel, {}),
        rates: types.optional(RatesModel, {}),
        quote: types.optional(QuoteModel, {}),
        lnd: types.optional(LndModel, {}), // TODO should it be optional?
    })
    .actions(self => {
        const update_transactions = flow(function*() {
            // TODO parrallel call?
            self.fiat.update_transactions()
            self.lnd.update_transactions()
            self.lnd.update_balance()
        })

        const update_balance = flow(function*() {
            // TODO parrallel call?
            self.rates.update()
            self.fiat.update_balance()
            self.lnd.update_balance()
        })

        return  { update_transactions, update_balance }
    })
    .views(self => ({
        get total_usd_balance() { // in USD
            return self.fiat.balance + self.lnd.balance * self.rates[self.lnd.currency]
        },

        get usd_balances() { // return an Object mapping account to USD balance
            const balances = {} // TODO refactor? AccountType.Bitcoin can't be used as key in constructor?
            balances[AccountType.Bitcoin] = self.lnd.balance * self.rates[self.lnd.currency]
            balances[AccountType.Checking] = self.fiat.balance
            return balances
        },

    }))

  /**
  * Un-comment the following to omit model attributes from your snapshots (and from async storage).
  * Useful for sensitive data like passwords, or transitive state like whether a modal is open.

  * Note that you'll need to import `omit` from ramda, which is already included in the project!
  *  .postProcessSnapshot(omit(["password", "socialSecurityNumber", "creditCardNumber"]))
  */

type DataStoreType = Instance<typeof DataStoreModel>
export interface DataStore extends DataStoreType {}

type DataStoreSnapshotType = SnapshotOut<typeof DataStoreModel>
export interface DataStoreSnapshot extends DataStoreSnapshotType {}



export type LndStore = Instance<typeof LndModel>

type FiatAccountType = Instance<typeof FiatAccountModel>
export interface FiatAccount extends FiatAccountType {}

// type CryptoAccountType = Instance<typeof LndModel> // FIXME is that still accurate?
// export interface CryptoAccount extends CryptoAccountType {}

type RatesType = Instance<typeof RatesModel>
export interface Rates extends RatesType {}