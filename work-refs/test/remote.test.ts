import { describe, expect, it } from "vitest";
import { mergeConfig, normalizeOrganization, normalizeRepo, parseRemote } from "../server/remote";

describe("parseRemote", () => {
  it("reads GitHub HTTPS and SSH remotes", () => {
    expect(parseRemote("https://github.com/acme/widgets.git").githubRepo).toBe("acme/widgets");
    expect(parseRemote("git@github.com:acme/widgets.js.git\n").githubRepo).toBe("acme/widgets.js");
  });

  it("reads Azure DevOps remotes", () => {
    const expected = { githubRepo: "", adoOrganization: "contoso", adoProject: "My Project" };
    expect(parseRemote("https://contoso@dev.azure.com/contoso/My%20Project/_git/app")).toEqual(expected);
    expect(parseRemote("git@ssh.dev.azure.com:v3/contoso/My%20Project/app")).toEqual(expected);
    expect(parseRemote("https://contoso.visualstudio.com/DefaultCollection/My%20Project/_git/app")).toEqual(expected);
    expect(parseRemote("contoso@vs-ssh.visualstudio.com:v3/contoso/My%20Project/app")).toEqual(expected);
  });

  it("returns nothing for other remotes", () => {
    expect(parseRemote("https://gitlab.com/acme/widgets.git")).toEqual({ githubRepo: "", adoOrganization: "", adoProject: "" });
  });
});

describe("normalize", () => {
  it("accepts organization names and URLs", () => {
    expect(normalizeOrganization("contoso")).toBe("contoso");
    expect(normalizeOrganization("https://dev.azure.com/contoso/")).toBe("contoso");
    expect(normalizeOrganization("https://contoso.visualstudio.com")).toBe("contoso");
    expect(normalizeOrganization("not an org")).toBeNull();
  });

  it("accepts owner/repo and GitHub URLs", () => {
    expect(normalizeRepo("acme/widgets")).toBe("acme/widgets");
    expect(normalizeRepo("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(normalizeRepo("widgets")).toBeNull();
  });
});

describe("mergeConfig", () => {
  it("prefers configured values per field", () => {
    const detected = { githubRepo: "a/b", adoOrganization: "org", adoProject: "proj" };
    expect(mergeConfig({ githubRepo: "c/d", adoOrganization: " ", adoProject: "" }, detected)).toEqual({
      githubRepo: "c/d",
      adoOrganization: "org",
      adoProject: "proj",
    });
  });
});
