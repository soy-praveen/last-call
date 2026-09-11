import { useEffect, useState, createContext, useContext, useCallback } from "react";
import { connectWallet, silentWallet, short, fmtUsd, type Wallet } from "./chain";
import { collateralBalance, ARENA, tx } from "./contract";
import { addrUrl } from "./chain";
import Home from "./pages/Home";
import Lobby from "./pages/Lobby";

type Ctx = {
  wallet: Wallet | null;
  connect: () => Promise<void>;
  balance: bigint | null;
  refreshBalance: () => void;
  toast: (msg: string, err?: boolean) => void;
};
const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

function useRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const m = hash.match(/^#\/lobby\/(\d+)/);
  return m ? { page: "lobby" as const, id: Number(m[1]) } : { page: "home" as const, id: 0 };
}

export default function App() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [toastMsg, setToastMsg] = useState<{ msg: string; err: boolean } | null>(null);
  const [fauceting, setFauceting] = useState(false);
  const route = useRoute();

  const refreshBalance = useCallback(() => {
    if (wallet) collateralBalance(wallet.address).then(setBalance).catch(() => {});
  }, [wallet]);

  useEffect(() => {
    silentWallet().then((w) => w && setWallet(w));
    const eth = window.ethereum;
    if (eth?.on) {
      const onAcc = () => silentWallet().then(setWallet);
      eth.on("accountsChanged", onAcc);
      eth.on("chainChanged", onAcc);
      return () => {
        eth.removeListener?.("accountsChanged", onAcc);
        eth.removeListener?.("chainChanged", onAcc);
      };
    }
  }, []);

  useEffect(() => {
    refreshBalance();
    const t = setInterval(refreshBalance, 8000);
    return () => clearInterval(t);
  }, [refreshBalance]);

  const toast = useCallback((msg: string, err = false) => {
    setToastMsg({ msg, err });
    setTimeout(() => setToastMsg(null), err ? 7000 : 4000);
  }, []);

  const connect = useCallback(async () => {
    try {
      setWallet(await connectWallet());
    } catch (e: any) {
      toast(e?.shortMessage || e?.message || String(e), true);
    }
  }, [toast]);

  return (
    <AppCtx.Provider value={{ wallet, connect, balance, refreshBalance, toast }}>
      <div className="wrap">
        <header className="top">
          <a className="brand" href="#/">
            <div className="logo">
              LAST <span>CALL</span>
            </div>
            <div className="tag">DreamDEX Event Contracts · Somnia Shannon</div>
          </a>
          <div className="right">
            <a className="pill" href={addrUrl(ARENA)} target="_blank" rel="noreferrer" title="Arena contract on the Somnia explorer">
              <span className="dot" /> arena <b>{short(ARENA)}</b>
            </a>
            {wallet && balance !== null && balance < 5_000_000n && (
              <button
                className="btn sm"
                disabled={fauceting}
                title="Mints 50 test tUSDC from the Shannon faucet contract. You need a little STT for gas."
                onClick={async () => {
                  setFauceting(true);
                  try {
                    await tx.faucet(wallet);
                    toast("50 tUSDC minted");
                    refreshBalance();
                  } catch (e: any) {
                    toast((e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 160) + " · need STT? testnet.somnia.network", true);
                  } finally {
                    setFauceting(false);
                  }
                }}
              >
                {fauceting ? "Minting…" : "Get 50 tUSDC"}
              </button>
            )}
            {wallet ? (
              <span className="pill">
                <b>{short(wallet.address)}</b> {balance !== null && <span>{fmtUsd(balance)} tUSDC</span>}
              </span>
            ) : (
              <button className="btn primary" onClick={connect}>
                Connect wallet
              </button>
            )}
          </div>
        </header>
        {route.page === "home" ? <Home /> : <Lobby id={route.id} />}
      </div>
      {toastMsg && <div className={`toast ${toastMsg.err ? "err" : ""}`}>{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}
