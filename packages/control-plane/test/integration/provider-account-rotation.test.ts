import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderDefaultStore } from "../../src/db/provider-account-defaults";
import { SessionIndexStore } from "../../src/db/session-index";
import { ProviderAccountSelectionPolicyError } from "../../src/model-provider-accounts/selection-policy";
import { initializeSession } from "../../src/session/initialize";
import { resolveSessionProviderAuth } from "../../src/session/provider-account-resolution";
import { cleanD1Tables } from "./cleanup";

const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);
const ACCOUNT_C = "c".repeat(32);

async function seedAccounts(ids: string[], strategy: "default" | "round_robin" = "round_robin") {
  const accounts = new ModelProviderAccountStore(env.DB);
  let now = 10;
  for (const id of ids) {
    await accounts.create({
      id,
      provider: "openai",
      displayName: `Seat ${id[0]}`,
      now: (now += 10),
    });
  }
  await new ProviderDefaultStore(env.DB).set(
    "openai",
    {
      providerAccountId: ids[0],
      unattendedMode: "provider_account",
      selectionStrategy: strategy,
      actorId: null,
    },
    100
  );
  return accounts;
}

async function openaiBinding(unattended = false) {
  const auth = await resolveSessionProviderAuth(env.DB, { unattended, harness: "opencode" });
  return auth.find((entry) => entry.provider === "openai")!;
}

describe("round-robin provider account selection", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("cycles through every active account, oldest connection first", async () => {
    await seedAccounts([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);
    const picks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const binding = await openaiBinding(i % 2 === 1);
      expect(binding).toMatchObject({
        authMode: "provider_account",
        selectionSource: "round_robin",
      });
      picks.push((binding as { providerAccountId: string }).providerAccountId);
    }
    expect(picks).toEqual([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_A]);
  });

  it("skips accounts that are not active and puts a newly connected account first", async () => {
    const accounts = await seedAccounts([ACCOUNT_A, ACCOUNT_B]);
    await accounts.setStatus(ACCOUNT_B, "reconnect_required", null, 200);
    for (let i = 0; i < 2; i += 1) {
      expect(await openaiBinding()).toMatchObject({ providerAccountId: ACCOUNT_A });
    }

    await accounts.create({ id: ACCOUNT_C, provider: "openai", displayName: "Seat c", now: 300 });
    expect(await openaiBinding()).toMatchObject({ providerAccountId: ACCOUNT_C });
    expect(await openaiBinding()).toMatchObject({ providerAccountId: ACCOUNT_A });
  });

  it("hands concurrent session creates distinct accounts", async () => {
    await seedAccounts([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);
    const bindings = await Promise.all([openaiBinding(), openaiBinding(), openaiBinding()]);
    const picked = bindings.map(
      (binding) => (binding as { providerAccountId: string }).providerAccountId
    );
    expect(new Set(picked).size).toBe(3);
  });

  it("keeps binding the default alone when rotation is off", async () => {
    await seedAccounts([ACCOUNT_A, ACCOUNT_B], "default");
    for (let i = 0; i < 3; i += 1) {
      expect(await openaiBinding()).toMatchObject({
        providerAccountId: ACCOUNT_A,
        selectionSource: "installation_default",
      });
    }
  });

  it("reports the usual configuration error when nothing is left to rotate over", async () => {
    const accounts = await seedAccounts([ACCOUNT_A]);
    await accounts.setStatus(ACCOUNT_A, "reconnect_required", null, 200);
    const error = await openaiBinding().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderAccountSelectionPolicyError);
    expect(error).toMatchObject({ status: 409 });
  });

  it("persists the rotated binding on the session", async () => {
    await seedAccounts([ACCOUNT_A, ACCOUNT_B]);
    const providerAuth = await resolveSessionProviderAuth(env.DB, {
      unattended: false,
      harness: "opencode",
    });
    const sessionId = `rotation-${Date.now()}`;
    await initializeSession(
      createCloudflareEnv(env),
      {
        sessionId,
        repoOwner: null,
        repoName: null,
        repoId: null,
        harness: "opencode",
        model: "openai/gpt-5.5",
        reasoningEffort: null,
        participantUserId: "user-1",
        platformUserId: null,
        managedSkillsManifest: {
          selection: { mode: "all" },
          resolverVersion: 1,
          manifestSha256: "0".repeat(64),
          resolvedAt: 1,
          skills: [],
        },
        providerAuth,
      },
      {
        db: env.DB,
        trace_id: "rotation-trace",
        request_id: "rotation-request",
        metrics: { queries: [], totalQueryDurationMs: 0 },
      } as never
    );

    await expect(
      new SessionIndexStore(env.DB).getCompleteProviderAuth(sessionId)
    ).resolves.toContainEqual({
      provider: "openai",
      authMode: "provider_account",
      providerAccountId: ACCOUNT_A,
      selectionSource: "round_robin",
    });
  });
});
