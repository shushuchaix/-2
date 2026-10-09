import test from "node:test";
import assert from "node:assert/strict";
import ncss from "../../src/sources/adapters/ncss.mjs";
import announcements from "../../src/sources/adapters/official-announcements.mjs";
import { readProviderPage } from "../../src/sources/collection-page.mjs";
test("ncss_follows_real_pages_beyond_two_even_with_an_empty_middle_page", async () => {
  const visited = [],
    request = async (url) => {
      const page = Number(new URL(url).searchParams.get("offset"));
      visited.push(page);
      return {
        status: 200,
        text: JSON.stringify({
          flag: true,
          data: {
            list:
              page === 2
                ? []
                : [
                    {
                      jobId: "j" + page,
                      jobName: "消防岗位",
                      recruitType: page === 3 ? "1" : "0",
                    },
                  ],
            pagenation: { count: 60 },
          },
        }),
      };
    };
  let cursor = null,
    second,
    last;
  for (let i = 0; i < 3; i++) {
    last = await readProviderPage(ncss, {
      unitId: "ncss-u",
      site: { siteId: "ncss" },
      query: { keyword: "合成", pageLimit: 4 },
      cursor,
      request,
    });
    if (i === 1) second = last;
    cursor = last.nextCursor;
  }
  assert.deepEqual(visited, [1, 2, 3]);
  assert.equal(second.done, false);
  assert.equal(last.nextCursor, null);
  assert.equal(last.records[0].kind, "recruitment_notice");
  visited.length = 0;
  await ncss.collect({
    sites: [{ siteId: "ncss" }],
    queries: [{ keyword: "合成", pageLimit: 4 }],
    request,
  });
  assert.deepEqual(visited, [1, 2, 3]);
});
test("verified_next_link_follows_same_site_list_2_and_blocks_private_or_foreign_links", async () => {
  const site = {
    siteId: "s",
    name: "合成机场",
    origin: "https://airport.example.org",
    template: {
      listUrl: "https://airport.example.org/jobs/list.html",
      linkRule: ".jobs a",
      bodyRule: "#body",
      pathPrefix: "/jobs/",
      nextPageRule: "a.next",
      paginationVerified: true,
    },
  };
  const visited = [],
    request = async (url) => {
      visited.push(url);
      return {
        status: 200,
        text: url.endsWith("list.html")
          ? '<div class="jobs"><a href="a.html">消防招聘</a></div><a class="next" href="list_2.html">下一页</a>'
          : '<div class="jobs"><a href="b.html">机场招聘</a></div>',
      };
    };
  const input = { unitId: "ann-u", site, query: { pageLimit: 4 }, request };
  const first = await readProviderPage(announcements, {
    ...input,
    cursor: null,
  });
  const second = await readProviderPage(announcements, {
    ...input,
    cursor: first.nextCursor,
  });
  assert.equal(second.records.length, 1);
  assert.equal(second.done, true);
  assert.deepEqual(visited, [
    site.template.listUrl,
    "https://airport.example.org/jobs/list_2.html",
  ]);
  const cycle = () =>
    readProviderPage(announcements, {
      ...input,
      cursor: { page: 2, url: "https://airport.example.org/jobs/list_2.html" },
      request: async () => ({
        status: 200,
        text: '<div class="jobs"><a href="a.html">消防招聘</a></div><a class="next" href="list_2.html">下一页</a>',
      }),
    });
  await assert.rejects(cycle(), { code: "pagination_cycle" });
  for (const url of [
    "http://127.0.0.1/private",
    "https://other.example.org/jobs/list_2.html",
  ]) {
    await assert.rejects(
      readProviderPage(announcements, { ...input, cursor: { page: 2, url } }),
      /pagination|分页|address|private/i,
    );
  }
});
