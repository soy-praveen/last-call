import { createPublicClient, createWalletClient, custom, http, formatUnits, type Address, type Hex, type WalletClient } from "viem";
import { somniaTestnet } from "viem/chains";

export const chain = somniaTestnet;
export const RPC = "https://dream-rpc.somnia.network";
export const EXPLORER = "https://shannon-explorer.somnia.network";

export const pub = createPublicClient({ chain, transport: http(RPC), batch: { multicall: true } });

export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
export const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const fmtUsd = (v: bigint | number, dp = 2) =>
  Number(typeof v === "bigint" ? formatUnits(v, 6) : v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtQty = (v: bigint) => Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const clock = (t: number) => new Date(t * 1000).toISOString().slice(11, 19) + " UTC";
export const mmss = (s: number) => {
  const c = Math.max(0, Math.floor(s));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
};

export type Wallet = { address: Address; client: WalletClient };

declare global {
  interface Window {
    ethereum?: any;
  }
}

export async function connectWallet(): Promise<Wallet> {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet found. Install MetaMask or another injected wallet.");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
  const hexId = `0x${chain.id.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e: any) {
    if (e?.code === 4902 || /unrecognized|not added|4902/i.test(String(e?.message))) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: "Somnia Shannon Testnet",
            nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
            rpcUrls: [RPC],
            blockExplorerUrls: [EXPLORER],
          },
        ],
      });
    } else {
      throw e;
    }
  }
  const client = createWalletClient({ chain, transport: custom(eth), account: address });
  return { address, client };
}

export async function silentWallet(): Promise<Wallet | null> {
  const eth = window.ethereum;
  if (!eth) return null;
  try {
    const accounts = (await eth.request({ method: "eth_accounts" })) as Address[];
    if (!accounts?.length) return null;
    const client = createWalletClient({ chain, transport: custom(eth), account: accounts[0] });
    return { address: accounts[0], client };
  } catch {
    return null;
  }
}

export type TxResult = { hash: Hex };
