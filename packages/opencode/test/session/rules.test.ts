import { expect, test } from "bun:test"
import { parseRulesFromMarkdown } from "../../src/session/rules"

test("parses only bullet rules from markdown", () => {
  expect(
    parseRulesFromMarkdown(`# Document\n prose is not a rule\n1. numbered text\n- actual rule\n* another rule\n`),
  ).toEqual(["actual rule", "another rule"])
})
