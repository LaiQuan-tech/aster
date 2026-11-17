/** 員工薪資頁下半部精簡 UI（2026-11-17）：靜態渲染。假資料。 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure, InfoTip, ListRow, SectionRow } from "../payroll-ui";
import { NhiDependentsCountField } from "../NhiDependentsCountField";

describe("payroll-ui", () => {
  it("SectionRow：一行標題＋摘要＋動作，沒有 children 就不畫表格／「無」列", () => {
    const html = renderToStaticMarkup(<SectionRow title="固定津貼" tip="長說明" summary="無" actions={<button>＋新增</button>} />);
    expect(html).toContain("固定津貼");
    expect(html).toContain(">無<");
    expect(html).toContain("＋新增");
    expect(html).not.toContain("<table");
    // ⓘ 提示預設收起：說明字只在 title（滑過）裡，不佔版面
    expect(html).toContain("ⓘ");
    expect(html).not.toContain('role="note"');
  });
  it("InfoTip：預設不展開", () => {
    const html = renderToStaticMarkup(<InfoTip text="每月自動帶入" />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="每月自動帶入"');
  });
  it("Disclosure：預設收合（hidden）、標題帶 ▸；動作只在展開後出現", () => {
    const html = renderToStaticMarkup(
      <Disclosure title="歷程紀錄（調薪 2・投保 1）" actions={<button>＋補登</button>}>
        <p>內容</p>
      </Disclosure>,
    );
    expect(html).toContain("歷程紀錄（調薪 2・投保 1）");
    expect(html).toContain("▸");
    expect(html).toMatch(/hidden=""[^>]*><p>內容<\/p>/);
    expect(html).not.toContain("＋補登");
    expect(renderToStaticMarkup(<Disclosure title="x" defaultOpen>y</Disclosure>)).toContain("▾");
  });
  it("ListRow：可換行（flex-wrap），不用表格", () => {
    const html = renderToStaticMarkup(<ListRow main="職務加給 3,000 元" meta="應稅｜計入投保" actions={<button>修改</button>} />);
    expect(html).toContain("flex-wrap");
    expect(html).toContain("應稅｜計入投保");
  });
  it("NhiDependentsCountField：主畫面一行＋修改連結，人數輸入預設收起；明細放在 children", () => {
    const html = renderToStaticMarkup(
      <NhiDependentsCountField employeeId="00000000-0000-4000-8000-000000000001" detailCount={2} reloadKey="a,b">
        <span>明細 2 筆</span>
      </NhiDependentsCountField>,
    );
    expect(html).toContain("健保眷屬：明細 2 筆");
    expect(html).toContain(">修改<");
    expect(html).toMatch(/hidden=""[^>]*><form/);
    expect(html).toContain("novalidate");
    expect(html).toContain("明細 2 筆");
  });
});
