import { gql, makeVar } from "@apollo/client"
import indexOf from "lodash.indexof"
import { remove, save } from "../utils/storage"
import { cache } from "./cache"

export const prefCurrencyVar = makeVar<CurrencyType>("USD")

export const nextPrefCurrency = (): void => {
  const units: CurrencyType[] = ["BTC", "USD"]
  const currentIndex = indexOf(units, prefCurrencyVar())
  prefCurrencyVar(units[(currentIndex + 1) % units.length])
}

export const modalClipboardVisibleVar = makeVar(false)

export const LAST_CLIPBOARD_PAYMENT = gql`
  query LastClipboardPayment {
    lastClipboardPayment @client
  }
`

export const HIDE_BALANCE = gql`
  query HideBalance {
    hideBalanceSettings @client
  }
`

export const WALKTHROUGH_TOOL_TIP = gql`
  query WalkThroughToolTip {
    walkThroughToolTipSettings @client
  }
`

export const saveHideBalanceSettings = (status: boolean): boolean => {
  try {
    cache.writeQuery({
      query: HIDE_BALANCE,
      data: {
        hideBalanceSettings: save("HIDE_BALANCE", true) ? status : remove("HIDE_BALANCE"),
      },
    })
    if (!status) {
      cache.evict({
        id: "HideBalance",
        fieldName: "hideBalanceSettings",
        broadcast: false,
      })
      cache.gc()
    }
    return status
  } catch {
    return false
  }
}

export const saveWalkThroughToolTipSettings = (status: boolean): boolean => {
  try {
    cache.writeQuery({
      query: WALKTHROUGH_TOOL_TIP,
      data: {
        walkThroughToolTipSettings: save("WALKTHROUGH_TOOL_TIP", true)
          ? status
          : remove("WALKTHROUGH_TOOL_TIP"),
      },
    })
    if (!status) {
      cache.evict({
        id: "WalkThroughToolTip",
        fieldName: "walkThroughToolTipSettings",
        broadcast: false,
      })
      cache.gc()
    }
    return status
  } catch {
    return false
  }
}
