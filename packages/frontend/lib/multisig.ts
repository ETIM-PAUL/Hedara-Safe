import { ethers } from "ethers";
import { getSafeAddress, getModuleAddress } from "./safe";
import { waitForMirrorNode, type RebalanceStatus } from "./txStatus";
import { assertCanPayGas } from "./wallet";

/**
 * Quorum-gated Safe proposals — generic over *which* Safe transaction is being proposed, not just
 * `RebalanceModule.rebalance()`. Both a rebalance and an owner-management call
 * (`addOwnerWithThreshold`/`removeOwner`, both `SelfAuthorized` on the Safe — see AGENTS.md) only
 * execute via a real Safe `execTransaction`, so every proposal here goes through the same
 * machinery: build the exact (to, data, nonce) tuple, get owners to approve its hash on-chain via
 * `approveHash()`, then submit `execTransaction()` once enough approvals exist. At threshold 1
 * this still takes an explicit "approve" and a separate explicit "execute" click (never auto-
 * chained — see useMultisigRebalance.ts); at a higher threshold it's a real multi-owner flow,
 * since `approveHash()` is what lets an owner commit their approval from their own wallet/session
 * without a backend to relay signatures.
 */

const SAFE_TX_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes memory signatures) payable returns (bool)"
];

const OWNER_MGMT_ABI = [
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)"
];

const MODULE_ABI = [
  "function rebalance(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 deadline) returns (uint256)"
];

const moduleIface = new ethers.Interface(MODULE_ABI);
const ownerMgmtIface = new ethers.Interface(OWNER_MGMT_ABI);

function safeContract(runner: ethers.Provider | ethers.Signer): ethers.Contract {
  return new ethers.Contract(getSafeAddress(), SAFE_TX_ABI, runner);
}

/** The `v=1, r=owner, s=0` "approved hash" scheme: valid when either `msg.sender == owner`
 * (submitting your own transaction) or `owner` has already called `approveHash()` on-chain for
 * this exact hash. Every signature in a multi-owner `execTransaction` call uses this form — no
 * real ECDSA signing needed, since on-chain approval already proves the owner's intent. */
function approvedHashSignature(owner: string): string {
  return ethers.concat([ethers.zeroPadValue(owner, 32), ethers.ZeroHash, "0x01"]);
}

function buildApprovedHashSignatures(approvedOwners: string[]): string {
  // Safe requires signatures sorted by signer address, ascending.
  const sorted = [...approvedOwners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return ethers.concat(sorted.map(approvedHashSignature));
}

/** Runs a Safe-contract-sending call through the same submit/pending/mirror-node status flow
 * every trigger in this app uses, so the UI's step tracker works identically here too. */
async function runSafeTx(
  send: () => Promise<ethers.ContractTransactionResponse>,
  onStatus: (status: RebalanceStatus) => void
): Promise<boolean> {
  onStatus({ stage: "submitting" });
  let tx: ethers.ContractTransactionResponse;
  try {
    tx = await send();
  } catch (error) {
    onStatus({ stage: "failed", error: (error as Error).message });
    return false;
  }

  onStatus({ stage: "pending", txHash: tx.hash });
  try {
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      onStatus({ stage: "failed", txHash: tx.hash, error: "Transaction reverted" });
      return false;
    }
  } catch (error) {
    onStatus({ stage: "failed", txHash: tx.hash, error: (error as Error).message });
    return false;
  }

  onStatus({ stage: "confirming", txHash: tx.hash });
  await waitForMirrorNode(tx.hash, onStatus);
  return true;
}

export type ProposalKind = "rebalance" | "addOwner" | "removeOwner";

export interface SafeProposal {
  kind: ProposalKind;
  to: string;
  data: string;
  nonce: string;
  /** The slippage tolerance (basis points) a `rebalance` proposer used to derive `amountOutMin`
   * from the quote at propose time. Not part of the Safe transaction itself — `amountOutMin` is
   * what's actually enforced on-chain — but an approving owner should be able to see what
   * tolerance produced that number. Unused by owner-management proposals. */
  slippageBps?: number;
}

async function nextNonce(provider: ethers.Provider): Promise<string> {
  const nonce: bigint = await safeContract(provider).nonce();
  return nonce.toString();
}

/** The exact Safe transaction a rebalance becomes — every approving owner is agreeing to this
 * bit-for-bit, since the Safe transaction hash covers all of it (including the Safe's current
 * nonce, so a stale proposal can't be replayed after another transaction has gone through). */
export async function buildRebalanceProposal(
  provider: ethers.Provider,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOutMin: bigint,
  deadline: number,
  slippageBps: number
): Promise<SafeProposal> {
  const data = moduleIface.encodeFunctionData("rebalance", [
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMin,
    deadline
  ]);
  return { kind: "rebalance", to: getModuleAddress(), data, nonce: await nextNonce(provider), slippageBps };
}

/** The Safe transaction that adds `owner` at `threshold`. `addOwnerWithThreshold` is
 * `SelfAuthorized` on the Safe — the only way to call it is a Safe transaction targeting the Safe
 * itself (`to = address(safe)`), which is why this needs the same propose/approve/execute
 * machinery as a rebalance even though no module is involved. */
export async function buildAddOwnerProposal(
  provider: ethers.Provider,
  newOwner: string,
  newThreshold: number
): Promise<SafeProposal> {
  const data = ownerMgmtIface.encodeFunctionData("addOwnerWithThreshold", [newOwner, newThreshold]);
  return { kind: "addOwner", to: getSafeAddress(), data, nonce: await nextNonce(provider) };
}

/** The Safe transaction that removes `ownerToRemove` and sets the threshold to `newThreshold`.
 * `removeOwner` needs `prevOwner` — the owner immediately before it in the Safe's internal linked
 * list — for O(1) removal; `getOwners()` returns owners in that same list order, so
 * `owners[i - 1]` (or the sentinel `0x1` if removing the first entry) is always correct. */
export async function buildRemoveOwnerProposal(
  provider: ethers.Provider,
  owners: string[],
  ownerToRemove: string,
  newThreshold: number
): Promise<SafeProposal> {
  const index = owners.findIndex((o) => o.toLowerCase() === ownerToRemove.toLowerCase());
  if (index === -1) throw new Error("That address isn't a current owner.");
  const SENTINEL_OWNERS = "0x0000000000000000000000000000000000000001";
  const prevOwner = index === 0 ? SENTINEL_OWNERS : owners[index - 1];
  const data = ownerMgmtIface.encodeFunctionData("removeOwner", [prevOwner, ownerToRemove, newThreshold]);
  return { kind: "removeOwner", to: getSafeAddress(), data, nonce: await nextNonce(provider) };
}

/** Proposals are shared between owners by copy/paste or the HCS relay (see hcs.ts) — a compact
 * blob of exactly the fields that determine the Safe transaction hash, nothing recomputed from
 * a live quote, so every owner is reviewing and approving the identical transaction. */
export function encodeProposal(proposal: SafeProposal): string {
  return btoa(JSON.stringify(proposal));
}

export function decodeProposal(blob: string): SafeProposal {
  let parsed: Partial<SafeProposal>;
  try {
    parsed = JSON.parse(atob(blob.trim()));
  } catch {
    throw new Error("That doesn't look like a valid proposal — check it was copied in full.");
  }
  if (!parsed.kind || !parsed.to || !parsed.data || parsed.nonce === undefined) {
    throw new Error("That doesn't look like a valid proposal — missing required fields.");
  }
  return parsed as SafeProposal;
}

/** The Safe's current nonce — a proposal's own `nonce` field must still match this for its hash
 * to mean anything; if another Safe transaction has gone through since, the proposal is stale
 * (its hash no longer corresponds to any executable transaction) and needs rebuilding. */
export async function getSafeNonce(provider: ethers.Provider): Promise<bigint> {
  return safeContract(provider).nonce();
}

export async function getProposalHash(provider: ethers.Provider, proposal: SafeProposal): Promise<string> {
  return safeContract(provider).getTransactionHash(
    proposal.to,
    0,
    proposal.data,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    proposal.nonce
  );
}

/** Which of the Safe's current owners have already approved this exact hash on-chain. */
export async function getApprovals(
  provider: ethers.Provider,
  owners: string[],
  hash: string
): Promise<string[]> {
  const safe = safeContract(provider);
  const flags = await Promise.all(owners.map((owner) => safe.approvedHashes(owner, hash)));
  return owners.filter((_, i) => (flags[i] as bigint) !== 0n);
}

export async function approveProposal(
  signer: ethers.Signer,
  hash: string,
  onStatus: (status: RebalanceStatus) => void
): Promise<void> {
  const safe = safeContract(signer);
  await runSafeTx(async () => {
    await assertCanPayGas(signer);
    return safe.approveHash(hash);
  }, onStatus);
}

/** Submits the proposal's action (rebalance or owner add/remove) once enough owners have
 * approved — anyone can call this (it doesn't need to be an owner), since the signatures already
 * carry every approving owner's on-chain-recorded consent. */
export async function executeProposal(
  signer: ethers.Signer,
  proposal: SafeProposal,
  approvedOwners: string[],
  onStatus: (status: RebalanceStatus) => void
): Promise<boolean> {
  const safe = safeContract(signer);
  const signatures = buildApprovedHashSignatures(approvedOwners);

  return runSafeTx(async () => {
    await assertCanPayGas(signer);
    return safe.execTransaction(
      proposal.to,
      0,
      proposal.data,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      signatures
    );
  }, onStatus);
}

export type DecodedAction =
  | {
      kind: "rebalance";
      tokenIn: string;
      tokenOut: string;
      amountIn: bigint;
      amountOutMin: bigint;
      deadline: number;
    }
  | { kind: "addOwner"; owner: string; threshold: number }
  | { kind: "removeOwner"; prevOwner: string; owner: string; threshold: number };

/** Decodes a proposal's raw calldata back into readable fields, dispatching on `proposal.kind` to
 * the right ABI — what an approving owner should actually inspect before approving, since the
 * blob itself could have come from anyone. */
export function decodeProposalAction(proposal: SafeProposal): DecodedAction {
  switch (proposal.kind) {
    case "rebalance": {
      const [tokenIn, tokenOut, amountIn, amountOutMin, deadline] = moduleIface.decodeFunctionData(
        "rebalance",
        proposal.data
      );
      return {
        kind: "rebalance",
        tokenIn: tokenIn as string,
        tokenOut: tokenOut as string,
        amountIn: amountIn as bigint,
        amountOutMin: amountOutMin as bigint,
        deadline: Number(deadline)
      };
    }
    case "addOwner": {
      const [owner, threshold] = ownerMgmtIface.decodeFunctionData("addOwnerWithThreshold", proposal.data);
      return { kind: "addOwner", owner: owner as string, threshold: Number(threshold) };
    }
    case "removeOwner": {
      const [prevOwner, owner, threshold] = ownerMgmtIface.decodeFunctionData("removeOwner", proposal.data);
      return {
        kind: "removeOwner",
        prevOwner: prevOwner as string,
        owner: owner as string,
        threshold: Number(threshold)
      };
    }
  }
}
