import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createCanvas } from "@napi-rs/canvas";
import {
  inspectDesktopUi,
  desktopContrastRatio,
} from "../../electron/self-test.mjs";
import postcss from "postcss";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Button } from "../../ui/src/components/ui/button";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../ui/src/components/ui/collapsible";
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

for (const contract of [
  "visibility",
  "44px styling",
  "inspector coverage",
] as const) {
  test(`closed Base UI Collapsible Trigger preserves ${contract}`, async (t) => {
    const view = render(
      <>
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" />}>
            简历正文
            <svg aria-hidden="true">
              <path d="M0 0h8" />
            </svg>
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <Button>正文内操作</Button>
          </CollapsibleContent>
        </Collapsible>
        <DialogPrimitive.Root open={false}>
          <DialogPrimitive.Portal keepMounted>
            <DialogPrimitive.Popup data-slot="dialog-content">
              <DialogPrimitive.Title>关闭弹层</DialogPrimitive.Title>
              <Button>弹层内操作</Button>
            </DialogPrimitive.Popup>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </>,
    );
    t.after(() => {
      view.unmount();
      cleanup();
    });
    const trigger = screen.getByRole("button", { name: "简历正文" });
    const panel = view.baseElement.querySelector(
      '[data-slot="collapsible-content"]',
    )!;
    const popup = view.baseElement.querySelector(
      '[data-slot="dialog-content"]',
    )!;
    assert.equal(trigger.dataset.slot, "collapsible-trigger");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(trigger.parentElement!.hasAttribute("data-closed"), true);
    assert.equal(panel.hasAttribute("data-closed"), true);
    assert.equal(popup.hasAttribute("data-closed"), true);
    const nestedRoot = trigger.parentElement!.cloneNode(true) as HTMLElement;
    const nestedTrigger = nestedRoot.querySelector(
      '[data-slot="collapsible-trigger"]',
    )!;
    nestedTrigger.setAttribute("aria-label", "关闭弹层内折叠入口");
    popup.append(nestedRoot);
    const rectangles = window.Element.prototype.getClientRects;
    const context = window.HTMLCanvasElement.prototype.getContext;
    // Deliberately give closed elements rectangles: their state must still block them.
    window.Element.prototype.getClientRects = () =>
      [new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList;
    window.HTMLCanvasElement.prototype.getContext = (() =>
      createCanvas(1, 1).getContext("2d")) as typeof context;
    try {
      if (contract === "visibility") {
        const source = fs.readFileSync(
          new URL("../../electron/self-test.mjs", import.meta.url),
          "utf8",
        );
        const visible = vm.runInNewContext(
          `(${source.match(/const visible = `([^`]+)`;/)![1]})`,
          { getComputedStyle },
        );
        assert.equal(
          visible(trigger),
          true,
          "closed trigger is a visible control",
        );
        for (const hidden of [
          panel,
          panel.querySelector("button"),
          popup,
          popup.querySelector("button"),
          nestedTrigger,
        ])
          assert.equal(visible(hidden), false);
        for (const attribute of ["hidden", "inert", "aria-hidden"]) {
          trigger.parentElement!.setAttribute(attribute, "true");
          assert.equal(
            visible(trigger),
            false,
            `${attribute} ancestor remains hidden`,
          );
          trigger.parentElement!.removeAttribute(attribute);
        }
        fireEvent.click(trigger);
        await waitFor(() =>
          assert.equal(trigger.getAttribute("aria-expanded"), "true"),
        );
        assert.equal(panel.hasAttribute("data-closed"), false);
      } else if (contract === "44px styling") {
        for (const property of ["min-height", "min-width"]) {
          const values: string[] = [];
          stylesheet.walkRules((rule) => {
            if (
              !rule.selector.includes('[data-slot="collapsible-trigger"]') ||
              !trigger.matches(rule.selector)
            )
              return;
            rule.walkDecls(property, (declaration) => {
              values.push(declaration.value);
            });
          });
          assert.ok(
            values.includes("44px"),
            `composed trigger has ${property}:44px`,
          );
        }
      } else {
        trigger.style.border = "1px solid black";
        trigger.style.backgroundColor = "white";
        trigger.querySelector("svg")!.style.color = "black";
        const result = vm.runInNewContext(
          `(${inspectDesktopUi.toString()})(${desktopContrastRatio.toString()})`,
          {
            document,
            NodeFilter: window.NodeFilter,
            getComputedStyle,
            innerWidth: 375,
            innerHeight: 900,
            devicePixelRatio: 1,
            matchMedia: window.matchMedia.bind(window),
          },
        );
        assert.ok(
          result.hitTargets.some(
            (item: { label: string }) => item.label === "简历正文",
          ),
          "actual composed trigger participates in hit audit",
        );
        assert.ok(
          result.boundaries.some(
            (item: { label: string }) => item.label === "简历正文",
          ),
          "actual composed trigger participates in boundary audit",
        );
        assert.ok(
          result.icons.some(
            (item: { label: string }) => item.label === "简历正文",
          ),
          "decorative icon under a closed root remains painted",
        );
        assert.equal(
          result.hitTargets.some(
            (item: { label: string }) =>
              item.label === "正文内操作" ||
              item.label === "弹层内操作" ||
              item.label === "关闭弹层内折叠入口",
          ),
          false,
        );
        assert.equal(
          result.icons.some(
            (item: { label: string }) => item.label === "关闭弹层内折叠入口",
          ),
          false,
        );
      }
    } finally {
      window.Element.prototype.getClientRects = rectangles;
      window.HTMLCanvasElement.prototype.getContext = context;
    }
  });
}
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

test("desktop inspector measures decorative close icons but excludes hidden ancestors", async (t) => {
  const view = render(
    <Sheet open>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>图标审计</SheetTitle>
        </SheetHeader>
      </SheetContent>
    </Sheet>,
  );
  t.after(() => {
    view.unmount();
    cleanup();
  });
  const close = await screen.findByRole("button", { name: "关闭" });
  const icon = close.querySelector("svg")!;
  assert.equal(
    icon.getAttribute("aria-hidden"),
    "true",
    "actual Lucide decorative SVG",
  );
  close.style.backgroundColor = "black";
  icon.style.color = "white";
  const popup = close.parentElement!;
  for (const attributes of [
    { "aria-hidden": "true" },
    { hidden: "" },
    { inert: "" },
    { "data-closed": "" },
    { style: "visibility:hidden" },
    { style: "opacity:0" },
    { style: "display:none" },
  ]) {
    const wrapper = document.createElement("div");
    for (const [name, value] of Object.entries(attributes))
      wrapper.setAttribute(name, value);
    wrapper.append(close.cloneNode(true));
    popup.append(wrapper);
  }
  // Supply layout only: this is a DOM selection/color test, not a native geometry claim.
  const rectangles = window.Element.prototype.getClientRects;
  const context = window.HTMLCanvasElement.prototype.getContext;
  window.Element.prototype.getClientRects = () =>
    [new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList;
  window.HTMLCanvasElement.prototype.getContext = (() =>
    createCanvas(1, 1).getContext("2d")) as typeof context;
  try {
    const result = vm.runInNewContext(
      `(${inspectDesktopUi.toString()})(${desktopContrastRatio.toString()})`,
      {
        document,
        NodeFilter: window.NodeFilter,
        getComputedStyle: window.getComputedStyle.bind(window),
        innerWidth: 375,
        innerHeight: 900,
        devicePixelRatio: 1,
        matchMedia: window.matchMedia.bind(window),
      },
    );
    assert.equal(
      result.icons.length,
      1,
      "visible aria-hidden SVG must count; hidden ancestors must not",
    );
    assert.equal(result.icons[0].label, "关闭");
    assert.equal(result.icons[0].ratio, 21);
    assert.equal(result.icons[0].required, 3);
    assert.equal(result.icons[0].ok, true);
  } finally {
    window.Element.prototype.getClientRects = rectangles;
    window.HTMLCanvasElement.prototype.getContext = context;
  }
});
