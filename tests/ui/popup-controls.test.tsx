import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import postcss from "postcss";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../ui/src/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../../ui/src/components/ui/sheet";

const stylesheet = postcss.parse(
  fs.readFileSync(new URL("../../ui/src/styles.css", import.meta.url), "utf8"),
);
for (const kind of ["dialog", "sheet"] as const) {
  test(`${kind} composed close button receives the workspace hit-target minimums`, async (t) => {
    const view = render(
      kind === "dialog" ? (
        <Dialog open>
          <DialogContent>
            <form>
              <DialogHeader>
                <DialogTitle>合成长标题关闭控件</DialogTitle>
              </DialogHeader>
            </form>
          </DialogContent>
        </Dialog>
      ) : (
        <Sheet open>
          <SheetContent>
            <form>
              <SheetHeader>
                <SheetTitle>合成长标题关闭控件</SheetTitle>
              </SheetHeader>
            </form>
          </SheetContent>
        </Sheet>
      ),
    );
    t.after(() => {
      view.unmount();
      cleanup();
    });
    const close = await screen.findByRole("button", { name: "关闭" });
    // Base UI replaces Button's data-slot: verify the rendered composition is
    // actually covered by the production stylesheet, without claiming geometry.
    assert.equal(close.dataset.slot, `${kind}-close`);
    const header = view.baseElement.querySelector(
      `[data-slot="${kind}-header"]`,
    )!;
    const endPadding: string[] = [];
    stylesheet.walkRules((rule) => {
      if (!rule.selector.includes(`[data-slot="${kind}-header"]`)) return;
      if (header.matches(rule.selector))
        rule.walkDecls("padding-inline-end", (declaration) => {
          endPadding.push(declaration.value);
        });
    });
    assert.ok(
      endPadding.includes(kind === "sheet" ? "64px" : "44px"),
      "form-wrapped header reserves close-button space independently of caller padding",
    );
    for (const property of ["min-width", "min-height"]) {
      const values: string[] = [];
      stylesheet.walkRules((rule) => {
        if (!rule.selector.includes("[data-slot=")) return;
        let matches = false;
        try {
          matches = close.matches(rule.selector);
        } catch {
          return;
        }
        if (matches)
          rule.walkDecls(property, (declaration) => {
            values.push(declaration.value);
          });
      });
      assert.ok(
        values.includes("44px"),
        `${kind}-close has no ${property}: 44px rule`,
      );
    }
  });
}
