/**
 * 後台（/admin）導覽的單一來源（純函式、無 React；全部有 vitest）。
 *
 * 2026-09 後台簡化：側欄 48 項收成 9 個分區（ADMIN_SECTIONS），每區用分頁（ADMIN_TABS）
 * 切換，既有網址全部保留；7 個沒在用的模組（ADMIN_MODULES）預設不列在分頁列與首頁，
 * 「設定 → 進階功能」把 tenants.features.adminModules[key] 勾成 true 才出現，直開網址不擋
 * （AdminShell 用 tabsForSection(…, { includeTab }) 把它塞回分頁列並標「未啟用」）。
 *
 * 這個檔案負責：
 *   - `ADMIN_SECTIONS`／`ADMIN_TABS`：分區與分頁的 key／label／href／title／desc
 *     （key 與 href 是其他工作包的依賴，**不要改名**）。
 *   - `ADMIN_ROUTES`：由分頁攤平的路由表；`resolveAdminPath()` 依 pathname 決定分區、分頁、
 *     頁首標題／說明、內容寬度、是否 detail 頁（動態子路徑）與返回鍵目標。
 *   - `tabsForSection()`／`subTabsFor()`／`homeEntries()`：AdminShell 分頁列與首頁分區入口。
 *   - `adminModulesOf()`／`isModuleEnabled()`：隱藏模組開關的讀法。
 *   - `ADMIN_REDIRECTS`：舊網址轉址；apps/web/next.config.ts 維持同一份（單元測試對照）。
 */

export type AdminSectionKey =
  | "home"
  | "finance"
  | "approvals"
  | "attendance"
  | "payroll"
  | "people"
  | "announce"
  | "settings"
  | "system";

export type AdminModuleKey =
  | "recruitment"
  | "kpi"
  | "ai"
  | "knowledge"
  | "dashboard"
  | "employeeMail"
  | "attendanceSettlement";

/** tenants.features.adminModules：module key → 是否列在導覽；缺席＝隱藏。 */
export type AdminModulesConfig = Partial<Record<AdminModuleKey, boolean>>;

/** 分區圖示名稱（SVG 定義在 components/AdminShell.tsx 的 ADMIN_ICONS）。 */
export type AdminIconName = AdminSectionKey;

export interface AdminSection {
  key: AdminSectionKey;
  label: string;
  icon: AdminIconName;
  /** 進入分區時開的第一個分頁。 */
  href: string;
  desc: string;
}

/** detail 頁（/admin/projects/[id] 這類動態子路徑）的頁首設定。 */
export interface AdminDetailDef {
  title: string;
  narrow?: boolean;
}

export interface AdminSubTab {
  key: string;
  label: string;
  href: string;
  /** 頁首 h1；省略＝label。 */
  title?: string;
  desc?: string;
  /** 內容區用 max-w-4xl（表單型頁面）取代 max-w-7xl。 */
  narrow?: boolean;
  detail?: AdminDetailDef;
}

export interface AdminTab {
  key: string;
  label: string;
  href: string;
  title?: string;
  desc?: string;
  narrow?: boolean;
  /** 隱藏模組：features.adminModules[module] === true 才列在分頁列。 */
  module?: AdminModuleKey;
  detail?: AdminDetailDef;
  /** 有子分頁時，路由由子分頁產生（tab 本身的 href 應等於第一個子分頁的 href）。 */
  children?: AdminSubTab[];
}

export interface AdminRoute {
  /** 路徑前綴（`/admin/projects` 也涵蓋 `/admin/projects/[id]`）。 */
  prefix: string;
  /** 有 pattern 的路由優先於前綴比對（例如專案申請單）。 */
  pattern?: RegExp;
  /** 只在精準相符時命中（首頁 /admin）。 */
  exact?: boolean;
  section: AdminSectionKey;
  /** 分頁 key；null＝首頁。 */
  tab: string | null;
  sub?: string;
  /** 頁首 h1；空字串＝首頁（AdminShell 不畫頁首）。 */
  title: string;
  desc?: string;
  narrow?: boolean;
  module?: AdminModuleKey;
  detail?: AdminDetailDef;
}

export interface ResolvedAdminRoute {
  route: AdminRoute;
  section: AdminSectionKey;
  tab: string | null;
  sub: string | null;
  /** detail 頁用 detail.title，其餘用 route.title。 */
  title: string;
  /** detail 頁不帶 desc（動態說明由頁面的 DetailHeading 補）。 */
  desc?: string;
  narrow: boolean;
  module?: AdminModuleKey;
  /** 動態子路徑（path !== route.prefix 且該路由有 detail；pattern 路由一律視為 detail）。 */
  isDetail: boolean;
  /** 返回鍵目標：detail 才有，＝去掉最後一段。 */
  parentPath: string | null;
}

/* --------------------------------------------------------------- 分區 --- */

/** 9 個分區，順序＝側欄順序。 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { key: "home", label: "首頁", icon: "home", href: "/admin", desc: "老闆數字卡與功能分區入口" },
  { key: "finance", label: "專案與財務", icon: "finance", href: "/admin/projects", desc: "專案、請款放款、獎金與名冊" },
  { key: "approvals", label: "假單與簽核", icon: "approvals", href: "/admin/approvals", desc: "簽核表單、假別餘額與月底核銷" },
  { key: "attendance", label: "出勤", icon: "attendance", href: "/admin/punch-records", desc: "打卡紀錄、出勤月表與班表" },
  { key: "payroll", label: "薪資與費用", icon: "payroll", href: "/admin/payroll", desc: "薪資、薪資單、稅務、報銷與預支" },
  { key: "people", label: "人員", icon: "people", href: "/admin/employees", desc: "員工主檔、部門組織圖與到職" },
  { key: "announce", label: "公告與資訊", icon: "announce", href: "/admin/announcements", desc: "公告與公司資訊頁" },
  { key: "settings", label: "設定", icon: "settings", href: "/admin/leave-types", desc: "假別、班別、行事曆、規則參數與站台" },
  { key: "system", label: "系統", icon: "system", href: "/admin/reports", desc: "報表、稽核紀錄、備份與通知" },
];

/* --------------------------------------------------------------- 分頁 --- */

/**
 * 各分區的分頁（順序＝分頁列順序）。title／desc 沿用各頁原本 <PageHeader> 的文案；
 * 有 children 的分頁其路由由子分頁產生。
 */
export const ADMIN_TABS: Readonly<Record<AdminSectionKey, readonly AdminTab[]>> = {
  home: [],
  finance: [
    {
      key: "projects",
      label: "專案",
      href: "/admin/projects",
      title: "專案與成員分潤",
      desc: "建立專案、指派成員與分潤比例／金額，並上傳專案文件。組員彼此看不到分潤，負責人與部門主管可見全部。",
      detail: { title: "專案明細" },
    },
    {
      key: "overview",
      label: "看板／甘特",
      href: "/admin/projects/overview",
      title: "專案總覽",
      desc: "看板依案情狀態分欄；甘特圖看預定期程與請款里程碑。點卡片進專案。",
    },
    {
      key: "receivables",
      label: "請款與未收款",
      href: "/admin/projects/receivables",
      title: "未收款追蹤",
      desc: "每期一列的應收／未收清單；排序看的是專案未收比例與逾期天數，不是金額大小",
    },
    {
      key: "disbursements",
      label: "放款",
      href: "/admin/disbursements",
      title: "放款專區",
      desc: "放款的單一真相：什麼時候、匯了多少、給誰；期款的已付狀態由這裡連動",
      children: [
        {
          key: "list",
          label: "放款作業",
          href: "/admin/disbursements",
          title: "放款專區",
          desc: "放款的單一真相：什麼時候、匯了多少、給誰；期款的已付狀態由這裡連動",
          detail: { title: "匯款單" },
        },
        {
          key: "pivot",
          label: "年度總覽",
          href: "/admin/disbursements/pivot",
          title: "放款年度總覽",
          desc: "一眼看今年給每家廠商／付款公司／專案多少錢，年底報稅用；只算已匯款（不含草稿／作廢）",
        },
      ],
    },
    {
      key: "bonus",
      label: "獎金季發放",
      href: "/admin/bonus-runs",
      desc: "專案獎金隨請款入帳進度同比例拆發、按季發放；每季存成獨立快照，已發放不可覆蓋，歷年可累計對比",
      detail: { title: "獎金批次" },
    },
    {
      key: "reports",
      label: "報表",
      href: "/admin/projects/annual",
      children: [
        {
          key: "annual",
          label: "年度總表",
          href: "/admin/projects/annual",
          title: "年度專案申請單總表",
          desc: "一列一案，依開案月份分區塊小計，最後年度總計；科別欄依租戶設定的順序排列",
        },
        {
          key: "stampDuty",
          label: "印花稅",
          href: "/admin/stamp-duty",
          title: "印花稅計算與申報備查清單",
          desc: "凡我方為承攬人或雙重身分（各自貼）且已簽訂的合約與追加減帳，自動納入本清單。報價單不是契據，不課印花稅。",
        },
        {
          key: "alerts",
          label: "專案示警",
          href: "/admin/projects/alerts",
          title: "AI 進度示警",
          desc: "依規則掃描所有未封存專案；急／注意等級每天早上推進通知中心",
        },
      ],
    },
    {
      key: "directory",
      label: "名冊",
      href: "/admin/clients",
      children: [
        {
          key: "clients",
          label: "客戶",
          href: "/admin/clients",
          title: "客戶名冊",
          desc: "業主／開票對象；建案時可直接選用，發票聯式與付款方式會預填到新專案",
        },
        {
          key: "vendors",
          label: "廠商",
          href: "/admin/vendors",
          title: "廠商名冊 · 名片建檔",
          desc: "往來廠商與窗口；拍名片自動帶入欄位，核對後建檔",
        },
        {
          key: "companies",
          label: "公司主體",
          href: "/admin/companies",
          title: "我方公司主體",
          desc: "開票／收款可能用不同主體（例如工程款與技師費分屬不同公司），下包分期的放款公司／收據抬頭會用到這裡的清單",
        },
      ],
    },
  ],
  approvals: [
    {
      key: "approvals",
      label: "簽核",
      href: "/admin/approvals",
      title: "簽核",
      desc: "待簽核、簽核中與歷史表單：批次核准／駁回、催簽、代理簽核、變更簽核人、註銷與匯出",
    },
    {
      key: "balances",
      label: "假別餘額",
      href: "/admin/leave-balances",
      title: "假別時數管理",
      desc: "特殊假確認、剩餘時數查詢、年度給假與全員批次給假",
    },
    {
      key: "settlement",
      label: "月底核銷",
      href: "/admin/leave-settlement",
      title: "假單月底核銷",
      desc: "每月月底檢視當月已核准假單、核對憑證，逐筆或整批標記已核銷",
    },
  ],
  attendance: [
    {
      key: "punches",
      label: "打卡紀錄",
      href: "/admin/punch-records",
      title: "打卡紀錄維護",
      desc: "查詢全公司打卡並進行補登",
    },
    {
      key: "sheets",
      label: "出勤月表與月結",
      href: "/admin/attendance-sheets",
      title: "出勤月表 · 月結簽核",
      desc: "依月份彙整全員出勤月表，追蹤送出／審核進度、產生本月與匯出",
      detail: { title: "出勤月表" },
    },
    {
      key: "schedules",
      label: "班表",
      href: "/admin/schedules",
      title: "排班與班表審核",
      desc: "支援單日排班、區間批次、CSV 匯入、單位/工時制篩選與員工確認/爭議狀態管理。",
    },
    {
      key: "settlement",
      label: "結算作業",
      href: "/admin/attendance-settlement",
      desc: "依薪資年月、資料類型、結算狀態與截止日完成設定、全數拋轉與下載",
      module: "attendanceSettlement",
    },
  ],
  payroll: [
    {
      key: "payroll",
      label: "薪資資料與執行",
      href: "/admin/payroll",
      title: "薪資作業",
      desc: "員工薪資保險資料與執行薪資作業；薪資單查詢與定案在薪資明細表",
    },
    {
      key: "payslips",
      label: "薪資單",
      href: "/admin/payslips",
      title: "薪資明細表",
      desc: "工資清冊：各期薪資單的應發、應扣與實發，逐列明細、列印與定案",
    },
    {
      key: "tax",
      label: "稅務申報",
      href: "/admin/payroll-tax",
      title: "薪資法規",
      desc: "批次調薪、非員工所得、二代健保補充保費試算、申報匯出",
    },
    {
      key: "expenses",
      label: "報銷",
      href: "/admin/expenses",
      title: "日常費用月結",
      desc: "同仁線上填報、月結一次性核銷。省的是逐筆事前審核，不是憑證。",
    },
    {
      key: "advances",
      label: "預支",
      href: "/admin/advances",
      title: "員工預支",
      desc: "出差預支與零用金預支共用同一條流程：核准 → 撥款 → 以實際報銷沖抵。核准與撥款是兩件事。",
    },
  ],
  people: [
    {
      key: "employees",
      label: "員工",
      href: "/admin/employees",
      title: "員工主檔",
      desc: "帳號、組織、到離職、My Data、學歷證照、工作經歷與年資",
    },
    {
      key: "departments",
      label: "部門與組織圖",
      href: "/admin/departments",
      desc: "維護單位名稱、上層單位與主管；右側同步顯示組織圖",
    },
    {
      key: "onboarding",
      label: "到職",
      href: "/admin/onboarding",
      title: "報到管理",
      desc: "新進人員報到，完成後建立正式員工資料",
    },
    {
      key: "recruitment",
      label: "招募",
      href: "/admin/recruitment",
      desc: "職缺需求、職缺公告、人才庫、面試行事曆、錄用申請與通知狀態",
      module: "recruitment",
    },
    {
      key: "kpi",
      label: "績效考核",
      href: "/admin/kpi",
      desc: "設定考核範本、按期間指派考核、追蹤評分進度並定案",
      module: "kpi",
    },
    {
      key: "employeeMail",
      label: "專屬 Email",
      href: "/admin/employee-mail",
      title: "專屬 Email 配發",
      desc: "每位員工一個公司網域信箱：配發、匯出給郵件供應商建立、回填狀態",
      module: "employeeMail",
    },
  ],
  announce: [
    {
      key: "announcements",
      label: "公告",
      href: "/admin/announcements",
      title: "公佈欄",
      desc: "發佈內部公告",
      detail: { title: "公告版本與簽收" },
    },
    {
      key: "companyInfo",
      label: "公司資訊頁",
      href: "/admin/company-info",
      title: "公司福利 / 職安資訊",
      desc: "長期有效的說明頁：員工在員工端「公司資訊」讀取。公告類請用公告。",
    },
    {
      key: "knowledge",
      label: "知識庫",
      href: "/admin/knowledge",
      desc: "把 SOP、規章、合約範本、專案文件放進來，用意思找、不用記關鍵字；AI 問答只依文件回答",
      module: "knowledge",
      children: [
        {
          key: "docs",
          label: "文件庫",
          href: "/admin/knowledge",
          title: "文件庫 · 語意搜尋",
          desc: "把 SOP、規章、合約範本、專案文件放進來，用意思找、不用記關鍵字",
        },
        {
          key: "ask",
          label: "AI 問答",
          href: "/admin/knowledge/ask",
          title: "AI 文件問答",
          desc: "只依知識庫裡的文件回答，每句附引用；文件裡沒有的會直說",
        },
      ],
    },
  ],
  settings: [
    {
      key: "leaveTypes",
      label: "假別與簽核流程",
      href: "/admin/leave-types",
      desc: "維護假別並設定各申請類別的簽核者",
    },
    {
      key: "shifts",
      label: "班別",
      href: "/admin/shifts",
      desc: "設定上下班時間",
      narrow: true,
    },
    {
      key: "calendar",
      label: "行事曆",
      href: "/admin/calendar",
      title: "行事曆 / 假日表",
      desc: "維護年度工作日曆：一般工作日、例假日、國定假日；沒有覆寫的日期預設週六日為例假日、其餘為工作日",
    },
    {
      key: "rules",
      label: "規則參數",
      href: "/admin/module-settings",
      title: "規則參數",
      desc: "差勤參數、勞健保費率、規則版本、表單參數與原始 JSON",
    },
    {
      key: "essTabs",
      label: "員工端功能開放",
      href: "/admin/module-settings/ess-tabs",
      desc: "依身分類別限縮員工端可見／可進入的分頁；未勾＝該類別看不到，直接打網址也會被擋。打卡首頁與公告一律開放。",
      narrow: true,
    },
    {
      key: "site",
      label: "站台與內部連結",
      href: "/admin/company-space",
      desc: "站台名稱、品牌色、員工入口／管理後台路徑，以及員工端「更多」頁的內部連結",
      narrow: true,
    },
    {
      key: "advanced",
      label: "進階功能",
      href: "/admin/settings/advanced",
      desc: "以下模組預設不在導覽列；勾選後出現在對應分區的分頁列，未勾選仍可直接輸入網址開啟",
      narrow: true,
    },
  ],
  system: [
    {
      key: "reports",
      label: "報表中心",
      href: "/admin/reports",
      desc: "出勤、請假/表單、薪資與人力快照報表：可篩選、可預覽表格、可下載 CSV。",
    },
    {
      key: "dashboard",
      label: "人力分析",
      href: "/admin/dashboard",
      desc: "全公司在職人數分析，支援自訂 widget 排版與個人化儲存。",
      module: "dashboard",
    },
    {
      key: "audit",
      label: "稽核紀錄",
      href: "/admin/audit-logs",
      desc: "誰在什麼時候改了什麼。由資料庫層自動記錄，任何人（含系統管理員）都無法修改或刪除。",
    },
    {
      key: "backups",
      label: "備份快照",
      href: "/admin/backups",
      title: "資料快照備份",
      desc: "每月 1 日 06:00 自動把上個月的全系統資料（人事／出勤／薪資／專案／放款／稽核 log）快照進私有儲存空間，作為 Final 版備查；也可隨時手動產生。",
    },
    {
      key: "notifications",
      label: "通知中心",
      href: "/admin/notifications",
      desc: "全租戶通知佇列、未讀狀態與提醒追蹤。",
    },
    {
      key: "ai",
      label: "AI 助理",
      href: "/admin/ai",
      desc: "Gemini 依同租戶報表、偵測與通知資料產生月報摘要，也可用自然語言詢問 HR 資料。",
      module: "ai",
    },
  ],
};

/* ---------------------------------------------------------- 隱藏模組 --- */

export interface AdminModuleDef {
  key: AdminModuleKey;
  label: string;
  desc: string;
  href: string;
  section: AdminSectionKey;
}

/** 7 個預設隱藏的模組（「設定 → 進階功能」勾回）；每個都對到 ADMIN_ROUTES 裡一條帶 module 的路由。 */
export const ADMIN_MODULES: readonly AdminModuleDef[] = [
  {
    key: "recruitment",
    label: "招募",
    desc: "職缺需求、職缺公告、人才庫、面試行事曆、錄用申請與通知狀態",
    href: "/admin/recruitment",
    section: "people",
  },
  {
    key: "kpi",
    label: "績效考核",
    desc: "設定考核範本、按期間指派考核、追蹤評分進度並定案",
    href: "/admin/kpi",
    section: "people",
  },
  {
    key: "ai",
    label: "AI 助理",
    desc: "Gemini 依同租戶報表、偵測與通知資料產生月報摘要，也可用自然語言詢問 HR 資料",
    href: "/admin/ai",
    section: "system",
  },
  {
    key: "knowledge",
    label: "知識庫",
    desc: "文件庫（語意搜尋）與 AI 文件問答",
    href: "/admin/knowledge",
    section: "announce",
  },
  {
    key: "dashboard",
    label: "人力分析",
    desc: "全公司在職人數分析，支援自訂 widget 排版與個人化儲存",
    href: "/admin/dashboard",
    section: "system",
  },
  {
    key: "employeeMail",
    label: "專屬 Email 配發",
    desc: "每位員工一個公司網域信箱：配發、匯出給郵件供應商建立、回填狀態",
    href: "/admin/employee-mail",
    section: "people",
  },
  {
    key: "attendanceSettlement",
    label: "結算作業",
    desc: "依薪資年月、資料類型、結算狀態與截止日完成設定、全數拋轉與下載",
    href: "/admin/attendance-settlement",
    section: "attendance",
  },
];

const MODULE_KEY_SET: ReadonlySet<string> = new Set<string>(ADMIN_MODULES.map((m) => m.key));

function isModuleKey(key: string): key is AdminModuleKey {
  return MODULE_KEY_SET.has(key);
}

/* ---------------------------------------------------------------- 轉址 --- */

export interface AdminRedirect {
  source: string;
  destination: string;
}

/**
 * 舊網址轉址（表單紀錄併入簽核頁、組織圖併入部門頁）。next.config.ts 的 redirects() 必須
 * 是同一份（它不能 import 這個檔——Next 只單獨編譯 next.config.ts），測試會對照。
 */
export const ADMIN_REDIRECTS: readonly AdminRedirect[] = [
  { source: "/admin/form-records", destination: "/admin/approvals?status=all" },
  { source: "/admin/org-chart", destination: "/admin/departments" },
];

/* ------------------------------------------------------------- 路由表 --- */

const HOME_ROUTE: AdminRoute = { prefix: "/admin", exact: true, section: "home", tab: null, title: "" };

function routesOfTab(section: AdminSectionKey, tab: AdminTab): AdminRoute[] {
  const base = { section, tab: tab.key, ...(tab.module ? { module: tab.module } : {}) };
  if (tab.children && tab.children.length > 0) {
    return tab.children.map<AdminRoute>((child) => ({
      ...base,
      prefix: child.href,
      sub: child.key,
      title: child.title ?? child.label,
      ...(child.desc !== undefined ? { desc: child.desc } : {}),
      ...((child.narrow ?? tab.narrow) ? { narrow: true } : {}),
      ...(child.detail ? { detail: child.detail } : {}),
    }));
  }
  return [
    {
      ...base,
      prefix: tab.href,
      title: tab.title ?? tab.label,
      ...(tab.desc !== undefined ? { desc: tab.desc } : {}),
      ...(tab.narrow ? { narrow: true } : {}),
      ...(tab.detail ? { detail: tab.detail } : {}),
    },
  ];
}

/**
 * 全部路由：首頁（精準）＋各分頁攤平（有 children 的分頁每個子分頁一條）＋pattern 路由
 * （專案申請單 /admin/projects/[id]/application，前綴比對會被專案明細搶走，所以用 pattern）。
 */
export const ADMIN_ROUTES: readonly AdminRoute[] = [
  HOME_ROUTE,
  ...ADMIN_SECTIONS.flatMap((section) => ADMIN_TABS[section.key].flatMap((tab) => routesOfTab(section.key, tab))),
  {
    pattern: /^\/admin\/projects\/[^/]+\/application$/,
    prefix: "/admin/projects",
    section: "finance",
    tab: "projects",
    title: "專案申請單",
    detail: { title: "專案申請單" },
  },
];

/** 去 query／hash／尾斜線；空字串回 "/"。 */
export function normalizeAdminPath(pathname: string): string {
  const noQuery = pathname.split(/[?#]/, 1)[0] ?? "";
  const trimmed = noQuery.length > 1 ? noQuery.replace(/\/+$/, "") : noQuery;
  return trimmed || "/";
}

function matchesRoute(path: string, route: AdminRoute): boolean {
  if (route.exact) return path === route.prefix;
  return path === route.prefix || path.startsWith(`${route.prefix}/`);
}

/**
 * 依 pathname 找對應路由：pattern 優先 → 最長前綴（`/admin/projects/overview` 只亮 overview，
 * 不會被 `/admin/projects` 搶走）；`/admin` 只在精準相符時是首頁；未知路徑 → 首頁路由（title ""）。
 * `isDetail`＝該路由有 detail 且 path !== prefix（pattern 路由一律是 detail）；`parentPath`＝去掉最後一段。
 */
export function resolveAdminPath(pathname: string): ResolvedAdminRoute {
  const path = normalizeAdminPath(pathname);
  let route = ADMIN_ROUTES.find((candidate) => candidate.pattern?.test(path));
  if (!route) {
    for (const candidate of ADMIN_ROUTES) {
      if (candidate.pattern || !matchesRoute(path, candidate)) continue;
      if (!route || candidate.prefix.length > route.prefix.length) route = candidate;
    }
  }
  if (!route) route = HOME_ROUTE;
  const isDetail = !!route.detail && path !== route.prefix;
  const detail = isDetail ? route.detail : undefined;
  const parentPath = isDetail ? path.slice(0, path.lastIndexOf("/")) : null;
  return {
    route,
    section: route.section,
    tab: route.tab,
    sub: route.sub ?? null,
    title: detail ? detail.title : route.title,
    ...(!detail && route.desc !== undefined ? { desc: route.desc } : {}),
    narrow: (detail ? (detail.narrow ?? route.narrow) : route.narrow) ?? false,
    ...(route.module ? { module: route.module } : {}),
    isDetail,
    parentPath,
  };
}

/** pathname 所屬分區（未知路徑＝首頁）。 */
export function sectionForPath(pathname: string): AdminSection {
  const key = resolveAdminPath(pathname).section;
  return ADMIN_SECTIONS.find((section) => section.key === key) ?? ADMIN_SECTIONS[0];
}

/** 返回鍵目標：只有 detail 頁有（去掉最後一段），其餘 null。 */
export function parentPathFor(pathname: string): string | null {
  return resolveAdminPath(pathname).parentPath;
}

/* ---------------------------------------------------------- 模組開關 --- */

/** 沒有 module key（一般分頁）→ 永遠啟用；有 key → 必須明確為 true。 */
export function isModuleEnabled(modules: AdminModulesConfig | null | undefined, key?: AdminModuleKey): boolean {
  if (!key) return true;
  return modules?.[key] === true;
}

/** 從 tenants.features 讀 adminModules：只收認得的 key 且值是 boolean，其餘忽略；沒有／格式不對 → {}。 */
export function adminModulesOf(features: Record<string, unknown> | null | undefined): AdminModulesConfig {
  const raw = features?.adminModules;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AdminModulesConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean" && isModuleKey(key)) out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------ 分頁列與首頁 --- */

/**
 * 分區的可見分頁：module 未啟用的剔除；`includeTab`（目前所在分頁 key）強制保留，
 * 讓直開隱藏模組網址時分頁列仍看得到自己（AdminShell 會標「未啟用」）。順序照表。
 */
export function tabsForSection(
  section: AdminSectionKey,
  modules: AdminModulesConfig | null | undefined,
  opts?: { includeTab?: string | null },
): AdminTab[] {
  const keep = opts?.includeTab ?? null;
  return ADMIN_TABS[section].filter((tab) => tab.key === keep || isModuleEnabled(modules, tab.module));
}

/** 某分頁的子分頁（沒有 children／找不到 → []）。 */
export function subTabsFor(section: AdminSectionKey, tab: string | null | undefined): AdminSubTab[] {
  if (!tab) return [];
  return [...(ADMIN_TABS[section].find((candidate) => candidate.key === tab)?.children ?? [])];
}

/** 首頁的 8 個分區入口（排除 home）。 */
export function homeEntries(): AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => section.key !== "home");
}
