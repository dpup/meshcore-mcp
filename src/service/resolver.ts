/**
 * Contact/channel resolution — the focused unit {@link MeshService} delegates
 * its name/index/key lookups to.
 *
 * It owns the order in which a free-form `target` is matched (contact by name,
 * then hex public-key prefix; channel by index, then name), the channel-aware
 * "not found" error (H6), the next-free-slot scan, and the home-node test. Most
 * device reads go through the same injected retry wrapper {@link MeshService}
 * uses, so behavior (retry/backoff, swallowed-vs-thrown) is identical to the
 * pre-extraction inline methods. The one exception is
 * {@link Resolver.resolveChannelByIndex}: it calls `client.getChannel` *directly*
 * (not via the wrapper), a best-effort index-enrich read whose failure is
 * swallowed to `undefined` rather than retried.
 *
 * Constructed with the injected {@link MeshCoreClient} and the service's
 * request-wrapper fn (so it shares the exact retry/idempotency policy); it
 * constructs neither the client nor a clock.
 */

import type { Channel, Contact, MeshCoreClient, SelfInfo } from "@dpup/meshcore-ts";

import { MeshCoreError } from "@dpup/meshcore-ts";

/**
 * Thrown by {@link Resolver.unknownChannelError} (surfaced from
 * {@link MeshService.sendMessage}/`deleteChannel`) when a `#`-prefixed target
 * resolves to no channel — channel-aware, unlike the generic contact miss (H6).
 * Carries a hint listing the known channels. A {@link MeshCoreError} subclass so
 * the tool layer's error formatter handles it on the same path as device errors.
 */
export class MeshServiceUnknownChannelError extends MeshCoreError {
  constructor(target: string, hint: string) {
    super(`no channel matches "${target}".${hint}`);
    this.name = "MeshServiceUnknownChannelError";
  }
}

/** The retry wrapper {@link MeshService} uses for idempotent device calls. */
export type RequestWrapper = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Resolves contacts and channels for {@link MeshService}. Shares the service's
 * injected client + retry wrapper so every lookup keeps the exact retry policy.
 */
export class Resolver {
  private readonly client: MeshCoreClient;
  private readonly request: RequestWrapper;

  /**
   * @param client - The injected {@link MeshCoreClient} (never constructed here).
   * @param request - The service's idempotent-call retry wrapper, so resolution
   *   reads keep the exact retry/backoff policy.
   */
  constructor(client: MeshCoreClient, request: RequestWrapper) {
    this.client = client;
    this.request = request;
  }

  /**
   * Resolve a contact by advertised name, then (failing that) by hex
   * public-key prefix. Returns `undefined` when neither matches.
   */
  async resolveContact(node: string): Promise<Contact | undefined> {
    const byName = await this.request(() => this.client.findContactByName(node));
    if (byName !== undefined) return byName;
    if (/^[0-9a-f]+$/i.test(node)) {
      return this.request(() => this.client.findContactByPublicKeyPrefix(node.toLowerCase()));
    }
    return undefined;
  }

  /**
   * Resolve a channel by index or name (a `#`-stripped ref). A purely numeric
   * ref is an index; otherwise it is matched by name. Returns `undefined` when
   * neither matches.
   */
  async resolveChannel(ref: string): Promise<Channel | undefined> {
    if (/^\d+$/.test(ref)) {
      return this.resolveChannelByIndex(Number(ref));
    }
    return this.request(() => this.client.findChannelByName(ref));
  }

  /**
   * Resolve a channel by its numeric index, returning `undefined` if the device
   * reports no such slot (a failed read is swallowed — the send itself still
   * goes out by index, the lookup is only to enrich the result digest).
   */
  async resolveChannelByIndex(idx: number): Promise<Channel | undefined> {
    try {
      return await this.client.getChannel(idx);
    } catch {
      return undefined;
    }
  }

  /**
   * Build a channel-aware "not found" error (H6): a `#`-target is unambiguously
   * a channel, so don't report a contact miss — say so and list the known
   * channels to choose from.
   */
  async unknownChannelError(target: string): Promise<MeshCoreError> {
    const known = (await this.request(() => this.client.getChannels()).catch(() => []))
      .filter((c) => c.name !== "")
      .map((c) => `#${c.name}`);
    const hint = known.length > 0 ? ` Known channels: ${known.join(", ")}.` : "";
    return new MeshServiceUnknownChannelError(target, hint);
  }

  /**
   * The next free channel slot. The device returns every slot (configured or
   * not) with empty-named ones free, so prefer the first empty-named slot;
   * fall back to one past the highest index when none is empty.
   */
  async nextFreeChannelIndex(): Promise<number> {
    const channels = await this.request(() => this.client.getChannels());
    const empty = channels.find((c) => c.name === "");
    if (empty !== undefined) return empty.channelIdx;
    return channels.reduce((max, c) => Math.max(max, c.channelIdx), -1) + 1;
  }

  /**
   * Whether `node` refers to the connected home device — by its advertised
   * name or by a hex prefix of its public key. Used to route a named/keyed
   * `nodeHealth`/`runAdmin` request to the home path rather than a remote login.
   */
  isHome(node: string, self: SelfInfo): boolean {
    if (node === self.name) return true;
    const ref = node.toLowerCase();
    return /^[0-9a-f]+$/.test(ref) && self.publicKey.startsWith(ref);
  }
}
