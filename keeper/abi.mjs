// ABIs the keeper needs that the SDK does not export from its main entry.
export const marketCreatedEvent = {
  type: "event",
  name: "MarketCreated",
  inputs: [
    { name: "marketId", type: "bytes32", indexed: true },
    { name: "market", type: "address", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "yesId", type: "uint256", indexed: false },
    { name: "noId", type: "uint256", indexed: false },
    { name: "collateral", type: "address", indexed: false },
    { name: "asset", type: "string", indexed: false },
    { name: "strike", type: "uint256", indexed: false },
    { name: "tradingStart", type: "uint64", indexed: false },
    { name: "expiry", type: "uint64", indexed: false },
    { name: "oracleQuestionId", type: "uint256", indexed: false },
    { name: "question", type: "string", indexed: false },
    { name: "intervalSec", type: "uint64", indexed: false },
  ],
};
export const erc20Abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "faucet", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
];
export const binaryMarketAbi = [
  { name: "isResolved", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "isVoided", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "status", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "payoutNumerators", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  { name: "expiry", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
];
export const binaryPoolAbi = [
  { name: "marketExpiryNs", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { name: "finalized", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "getOrderBookParameters", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "tuple", components: [{ name: "tickSize", type: "uint256" }, { name: "minQuantity", type: "uint256" }, { name: "lotSize", type: "uint256" }] }] },
  { name: "getBookLevels", type: "function", stateMutability: "view", inputs: [{ name: "isBid", type: "bool" }, { name: "n", type: "uint64" }], outputs: [{ type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }] },
  { name: "getBinaryPoolParams", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "tuple", components: [
    { name: "collateralToken", type: "address" }, { name: "market", type: "address" }, { name: "outcomeToken", type: "address" }, { name: "yesId", type: "uint256" }, { name: "noId", type: "uint256" }, { name: "oneCollateral", type: "uint256" }, { name: "setBacking", type: "uint256" }, { name: "feeRecipient", type: "address" }, { name: "makerFeeBpsTimes1k", type: "uint256" }, { name: "takerFeeBpsTimes1k", type: "uint256" }, { name: "maxBuilderFeeBpsTimes1k", type: "uint256" }, { name: "settlementFeeBpsTimes1k", type: "uint256" }, { name: "settlement", type: "address" }, { name: "marketNonce", type: "uint64" }, { name: "finalized", type: "bool" } ] }] },
];
