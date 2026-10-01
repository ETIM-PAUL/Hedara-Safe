/**
 * Reads are pure mirror-node fetches — public, no key needed, same pattern as every other
 * verification in this app. Writes go through /api/proposals, the one place this app holds a
 * private key server-side, since there's no way to submit an HCS message straight from the
 * browser's EVM wallet (MetaMask can't produce a native Hedera transaction).
 */

const MIRROR_NODE_BASE = "https://testnet.mirrornode.hedera.com";

export function getProposalsTopicId(): string | null {
  return process.env.NEXT_PUBLIC_PROPOSALS_TOPIC_ID || null;
}

export function hashscanTopicUrl(topicId: string): string {
  return `https://hashscan.io/testnet/topic/${topicId}`;
}

/** Best-effort — a failed publish just means the proposer falls back to the copy/paste button
 * that's always shown alongside it. Never throws. */
export async function publishProposal(blob: string): Promise<boolean> {
  try {
    const response = await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob })
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface TopicProposal {
  blob: string;
  sequenceNumber: number;
  consensusTimestamp: string;
}

interface MirrorTopicMessage {
  message: string; // base64 of the raw HCS message bytes
  sequence_number: number;
  consensus_timestamp: string;
}

/** Most recent proposals published to the topic, newest first. Each message's `message` field is
 * mirror node's own base64 wrapper around whatever bytes were submitted — one unwrap (atob) gets
 * back the same base64 blob `encodeProposal()`/`decodeProposal()` in multisig.ts already speak,
 * so nothing downstream needs to know these came from HCS rather than a pasted blob. */
export async function fetchRecentProposals(limit = 10): Promise<TopicProposal[]> {
  const topicId = getProposalsTopicId();
  if (!topicId) return [];

  const response = await fetch(
    `${MIRROR_NODE_BASE}/api/v1/topics/${topicId}/messages?order=desc&limit=${limit}`
  );
  if (!response.ok) return [];

  const data = (await response.json()) as { messages?: MirrorTopicMessage[] };
  return (data.messages ?? []).map((m) => ({
    blob: atob(m.message),
    sequenceNumber: m.sequence_number,
    consensusTimestamp: m.consensus_timestamp
  }));
}
