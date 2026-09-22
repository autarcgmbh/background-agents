import { describe, expect, it } from "vitest";
import { composeProviderAccountTags, sanitizeTagValue } from "./agento11y-tags";

const ACCOUNT_ID = "a".repeat(32);

describe("composeProviderAccountTags", () => {
  it("emits the account name and id as tags", () => {
    expect(composeProviderAccountTags(undefined, { id: ACCOUNT_ID, displayName: "Team A" })).toBe(
      `provider_account=Team A,provider_account_id=${ACCOUNT_ID}`
    );
  });

  it("puts operator tags last so an explicit duplicate key wins", () => {
    expect(
      composeProviderAccountTags(" team=dev,provider_account=override ", {
        id: ACCOUNT_ID,
        displayName: "Team A",
      })
    ).toBe(
      `provider_account=Team A,provider_account_id=${ACCOUNT_ID},team=dev,provider_account=override`
    );
  });

  it("keeps a display name inside the key=value,key=value grammar", () => {
    expect(sanitizeTagValue("Ops, EU = prod\tseat", ACCOUNT_ID)).toBe("Ops EU prod seat");
    expect(sanitizeTagValue(",=", ACCOUNT_ID)).toBe(ACCOUNT_ID);
  });
});
