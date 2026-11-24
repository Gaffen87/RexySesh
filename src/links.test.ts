import { expect, test } from "bun:test"
import { toSessionLinks } from "./links.ts"
import { plain } from "./text.ts"
import type { LinkRow } from "./view.ts"

test("the links for the palette carry no colors, and start with the branch's pull request", () => {
  const rows: LinkRow[] = [
    { kind: "repository", url: "https://github.com/acme/app", title: "acme/app", detail: "repository", markerColor: plain },
    { kind: "pullRequest", url: "https://github.com/acme/app/pull/6", title: "#6 Below", detail: "1/2 · open", markerColor: plain, isOnCurrentBranch: false },
    { kind: "pullRequest", url: "https://github.com/acme/app/pull/7", title: "#7 Current", detail: "2/2 · open", markerColor: plain, isOnCurrentBranch: true },
    { kind: "devServer", url: "http://localhost:5173", title: "localhost:5173", detail: "vite", markerColor: plain },
  ]
  const sessionLinks = toSessionLinks(rows)
  expect(sessionLinks.map((sessionLink) => sessionLink.url)).toEqual([
    "https://github.com/acme/app/pull/7",
    "https://github.com/acme/app",
    "https://github.com/acme/app/pull/6",
    "http://localhost:5173",
  ])
  expect(sessionLinks[0]).toEqual({
    kind: "pullRequest",
    url: "https://github.com/acme/app/pull/7",
    title: "#7 Current",
    detail: "2/2 · open",
    isOnCurrentBranch: true,
  })
})
