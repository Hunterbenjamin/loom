import { chromium, type Page } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const root = join(tmpdir(), "loom-spike-04");
process.env.TMPDIR = root;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const browserCdp = await browser.newBrowserCDPSession();
const launch = z
  .object({ arguments: z.array(z.string()) })
  .parse(await browserCdp.send("Browser.getBrowserCommandLine"));
const profileIsInScratch = launch.arguments.some((arg) =>
  arg.startsWith(`--user-data-dir=${root}/`),
);
if (!profileIsInScratch) {
  await browser.close();
  throw new Error("Browser profile must stay in spike scratch");
}
const results: { name: string; passed: boolean; detail?: unknown; error?: string }[] = [];
const stateSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      line: z.number(),
      resolved: z.boolean(),
      replies: z.array(z.string()),
      draft: z.string(),
    }),
  ),
  revision: z.number(),
  selection: z.unknown(),
  active: z.number(),
  viewed: z.array(z.string()),
  rendered: z.array(z.object({ id: z.string(), version: z.number(), name: z.string() })),
});
const state = async (page: Page) =>
  stateSchema.parse(await page.evaluate(() => window.spike.snapshot?.()));
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
async function load(annotations = 50, workers = "1", fixture = "medium") {
  await page.goto(
    `http://127.0.0.1:4404/?fixture=${fixture}&workers=${workers}&annotations=${annotations}`,
  );
  await page.waitForFunction(() => window.spike.metrics.firstDiffMs != null);
  await page.waitForTimeout(1000);
}
async function check(name: string, run: () => Promise<unknown>) {
  try {
    const detail = await run();
    results.push({ name, passed: true, detail });
    console.log("PASS", name, JSON.stringify(detail ?? null));
  } catch (error) {
    const message = String(error).split("\n").slice(0, 4).join("\n");
    results.push({ name, passed: false, error: message });
    console.log("FAIL", name, message);
  }
}
try {
  await check("50 cards; resolve, reply, and draft survive virtualization", async () => {
    await load();
    assert.equal((await state(page)).findings.length, 50);
    const card = page.locator('[data-finding="finding-0"]');
    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await card.getByRole("textbox").fill("Confirmed by the spike.");
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    await card.getByRole("textbox").fill("Unsaved draft retained");
    await page.evaluate(() => window.spike.scrollTo?.(49));
    await page.waitForTimeout(700);
    assert.equal(await card.count(), 0);
    await page.evaluate(() => window.spike.scrollTo?.(0));
    await card.waitFor();
    assert.equal(await card.getByRole("textbox").inputValue(), "Unsaved draft retained");
    assert.ok(await card.getByRole("button", { name: "Reopen" }).isVisible());
    const finding = (await state(page)).findings[0];
    assert.ok(finding.replies.includes("Confirmed by the spike."));
    await page.screenshot({ path: join(root, "review-dark.png") });
    return {
      findings: 50,
      retainedResolved: finding.resolved,
      replies: finding.replies.length,
      draftRetained: true,
    };
  });
  await check("custom fonts, light theme and unified view", async () => {
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("button", { name: "Unified", exact: true }).click();
    await page.waitForTimeout(500);
    const styles = await page.evaluate(() => {
      const host = document.querySelector("diffs-container")!;
      const code = host.shadowRoot!.querySelector("code")!;
      return {
        font: getComputedStyle(code).fontFamily,
        lineHeight: getComputedStyle(code).lineHeight,
        theme: document.documentElement.dataset.theme,
        pre: [...host.shadowRoot!.querySelector("pre")!.attributes].map((a) => [a.name, a.value]),
        fontLoaded: document.fonts.check('12px "JetBrains Mono Variable"'),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.equal(styles.theme, "light");
    assert.ok(styles.font.includes("JetBrains Mono"));
    assert.ok(styles.fontLoaded);
    assert.equal(styles.horizontalOverflow, false);
    await page.screenshot({ path: join(root, "review-light-unified.png") });
    return styles;
  });
  await check("pointer line selection starts a human comment", async () => {
    await load(0);
    const first = page.locator("diffs-container").first();
    // Pierre selects review lines from the number gutter; code dragging is native text selection.
    const lines = first.locator("[data-additions] [data-column-number]");
    const a = await lines.nth(0).boundingBox();
    const b = await lines.nth(2).boundingBox();
    assert.ok(a && b);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const selected = (await state(page)).selection;
    assert.ok(selected);
    await page.getByRole("button", { name: /^Comment on/ }).click();
    assert.equal((await state(page)).findings.length, 1);
    return { selected, created: (await state(page)).findings[0] };
  });
  await check("full contents expand unchanged regions", async () => {
    await load(0);
    const first = page.locator("diffs-container").first();
    const firstLine = await first
      .locator("[data-additions] [data-line]")
      .first()
      .getAttribute("data-line");
    await first.locator("[data-expand-button]").first().click();
    await page.waitForTimeout(700);
    const expandedFirstLine = await first
      .locator("[data-additions] [data-line]")
      .first()
      .getAttribute("data-line");
    assert.ok(Number(expandedFirstLine) < Number(firstLine));
    return { firstLine, expandedFirstLine };
  });
  await check("file jump, viewed checkbox, collapse and host keyboard shortcut", async () => {
    await load(0);
    await page.getByRole("checkbox", { name: "Viewed 0", exact: true }).check();
    assert.equal((await state(page)).viewed.length, 1);
    await page.getByRole("button", { name: "Collapse 0", exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator("diffs-container").first().locator("[data-code]").count(), 0);
    await page.getByRole("button", { name: "Collapse 0", exact: true }).click();
    await page.keyboard.press("Alt+ArrowDown");
    await page.waitForTimeout(500);
    const s = await state(page);
    assert.equal(s.active, 1);
    assert.ok(s.rendered.some((i) => i.id.includes("compile.spec.ts")));
    return { viewed: s.viewed.length, active: s.active, rendered: s.rendered.length };
  });
  for (const workers of ["0", "1"]) {
    await check(`replacement with same item version is ignored (workers=${workers})`, async () => {
      await load(50, workers);
      await page.getByRole("button", { name: "Replace, same version", exact: true }).click();
      await page.waitForTimeout(700);
      const inserted = await page
        .locator("diffs-container")
        .first()
        .locator("[data-code]")
        .evaluateAll((elements) =>
          elements.some((e) => e.textContent?.includes("inserted header")),
        );
      assert.equal(inserted, false);
      assert.equal((await state(page)).revision, 0);
      return { insertedHeaderRendered: inserted };
    });
    await check(
      `naive replacement retains the old numeric anchor (workers=${workers})`,
      async () => {
        await load(50, workers);
        const originalLine = (await state(page)).findings[0].line;
        const oldText = await page
          .locator("diffs-container")
          .first()
          .locator(`[data-additions] [data-line="${originalLine}"]`)
          .textContent();
        await page.getByRole("button", { name: "Replace naïvely", exact: true }).click();
        await page.waitForTimeout(700);
        const next = await state(page);
        assert.equal(next.findings[0].line, originalLine);
        // The old numeric location can now sit inside collapsed context, so
        // inspect the actual target's new visible line instead of requiring an old row.
        const targetText = await page
          .locator("diffs-container")
          .first()
          .locator(`[data-additions] [data-line="${originalLine + 5}"]`)
          .textContent();
        assert.equal(targetText, oldText);
        const oldLineVisible =
          (await page
            .locator("diffs-container")
            .first()
            .locator(`[data-additions] [data-line="${originalLine}"]`)
            .count()) > 0;
        const inserted = await page
          .locator("diffs-container")
          .first()
          .locator("[data-code]")
          .evaluateAll((elements) =>
            elements.some((e) => e.textContent?.includes("inserted header")),
          );
        assert.equal(inserted, true);
        const slot = await page
          .locator('[data-finding="finding-0"]')
          .evaluate((el) => el.parentElement?.getAttribute("slot"))
          .catch(() => null);
        return {
          originalLine,
          nextLine: next.findings[0].line,
          expectedMovedLine: originalLine + 5,
          insertedHeaderRendered: inserted,
          anchorDoesNotFollowTarget: true,
          oldLineVisible,
          slot,
        };
      },
    );
    await check(
      `host reanchor moves the same finding to the shifted code (workers=${workers})`,
      async () => {
        await load(50, workers);
        const originalLine = (await state(page)).findings[0].line;
        const oldText = await page
          .locator("diffs-container")
          .first()
          .locator(`[data-additions] [data-line="${originalLine}"]`)
          .textContent();
        await page.getByRole("button", { name: "Replace + reanchor", exact: true }).click();
        await page.waitForTimeout(700);
        const next = await state(page);
        assert.equal(next.findings[0].line, originalLine + 5);
        const movedText = await page
          .locator("diffs-container")
          .first()
          .locator(`[data-additions] [data-line="${originalLine + 5}"]`)
          .textContent();
        assert.equal(movedText, oldText);
        const slot = await page
          .locator('[data-finding="finding-0"]')
          .evaluate((el) => el.parentElement?.getAttribute("slot"));
        assert.equal(slot, `annotation-additions-${originalLine + 5}`);
        return {
          originalLine,
          nextLine: next.findings[0].line,
          sameId: next.findings[0].id === "finding-0",
          sameCodeText: true,
          slot,
        };
      },
    );
  }
  await check("200 cards are accepted and far-file cards mount", async () => {
    await load(200);
    assert.equal((await state(page)).findings.length, 200);
    const initialMounted = await page.locator("[data-finding]").count();
    await page.evaluate(() => window.spike.scrollTo?.(49));
    await page.waitForTimeout(700);
    assert.ok(await page.locator('[data-finding="finding-49"]').count());
    return { total: 200, initialMounted, farFileCardMounted: true };
  });
  await check("binary and rename input presentation", async () => {
    await load(0, "1", "edges");
    await page.evaluate(() => window.spike.scrollTo?.(1));
    await page.waitForTimeout(500);
    const summaries = await page.locator("diffs-container").evaluateAll((hosts) =>
      hosts.map((host) => {
        const copy = document.createElement("div");
        copy.innerHTML = host.shadowRoot?.innerHTML ?? "";
        copy.querySelectorAll("style,svg").forEach((el) => el.remove());
        return {
          text: copy.textContent?.replace(/\s+/g, " ").trim(),
          contentLines: host.shadowRoot?.querySelectorAll("[data-code] [data-line]").length,
        };
      }),
    );
    await page.screenshot({ path: join(root, "edge-inputs.png") });
    return summaries;
  });
} finally {
  writeFileSync(
    join(root, "features.json"),
    JSON.stringify(
      { browser: browser.version(), profileIsInScratch, results, pageErrors: errors },
      null,
      2,
    ),
  );
  await browser.close();
}
if (results.some((r) => !r.passed) || errors.length) process.exitCode = 1;
