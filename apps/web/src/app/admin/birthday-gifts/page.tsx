"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BottomSheet,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Input,
  Textarea,
  useToast,
} from "@/components/admin-ui";
import { fileToBase64 } from "@/lib/files";
import {
  createBirthdayGift,
  deleteBirthdayPhoto,
  getUpcomingBirthdays,
  listBirthdayGifts,
  updateBirthdayGift,
  uploadBirthdayPhoto,
  type BirthdayGift,
  type BirthdayPerson,
} from "@/lib/people-extras-api";

/**
 * 生日紅包登記（M7）。
 *
 * 版面就是客戶描述的流程：**當月壽星一張表**（提醒通知也是照這份名單發），
 * 發了紅包在該列登記金額／日期／備註，再把現場照片拍上去。照片走私有 bucket，
 * 每次載入拿 900 秒的 signed URL，不會有可外流的永久連結。
 *
 * 年度總額另外列在下面：這是老闆會問的第二個問題（「今年包了多少」）。
 */

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : Math.round(n).toLocaleString("zh-TW");
}

/** 2/29 出生者在平年以 2/28 計：兩個日期不同時把原始生日也標出來。 */
function birthdayLabel(person: BirthdayPerson): string {
  const observed = person.date.slice(5).replace("-", "/");
  const actual = person.birthday.slice(5).replace("-", "/");
  return observed === actual ? observed : `${observed}（生日 ${actual}）`;
}

interface FormState {
  person: BirthdayPerson;
  amount: string;
  givenOn: string;
  note: string;
}

export default function BirthdayGiftsPage() {
  const toast = useToast();
  const [month, setMonth] = useState(monthKey());
  const [people, setPeople] = useState<BirthdayPerson[] | null>(null);
  const [yearGifts, setYearGifts] = useState<{ gifts: BirthdayGift[]; totalAmount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingPhotoFor = useRef<string | null>(null);

  const year = Number(month.slice(0, 4));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [upcoming, gifts] = await Promise.all([
        getUpcomingBirthdays(month),
        listBirthdayGifts(Number(month.slice(0, 4))),
      ]);
      setPeople(upcoming.birthdays);
      setYearGifts({ gifts: gifts.gifts, totalAmount: gifts.totalAmount });
    } catch (err) {
      setPeople((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  function openForm(person: BirthdayPerson) {
    setForm({
      person,
      amount: person.gift?.amount != null ? String(person.gift.amount) : "",
      givenOn: person.gift?.given_on ?? person.date,
      note: person.gift?.note ?? "",
    });
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const amount = form.amount.trim() === "" ? null : Number(form.amount);
      if (amount !== null && !Number.isFinite(amount)) throw new Error("金額請填數字");
      const body = {
        amount,
        givenOn: form.givenOn || null,
        note: form.note.trim() || null,
      };
      if (form.person.gift) await updateBirthdayGift(form.person.gift.id, body);
      else await createBirthdayGift({ employeeId: form.person.employeeId, year, ...body });
      toast.show("已登記", "success");
      setForm(null);
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "登記失敗", "error");
    } finally {
      setSaving(false);
    }
  }

  function pickPhoto(giftId: string) {
    pendingPhotoFor.current = giftId;
    fileInput.current?.click();
  }

  async function onPhotoPicked(file: File | undefined) {
    const giftId = pendingPhotoFor.current;
    pendingPhotoFor.current = null;
    if (!file || !giftId) return;
    setUploadingId(giftId);
    try {
      await uploadBirthdayPhoto(giftId, {
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64: await fileToBase64(file),
      });
      toast.show("照片已上傳", "success");
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "上傳失敗", "error");
    } finally {
      setUploadingId(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removePhoto(giftId: string) {
    setUploadingId(giftId);
    try {
      await deleteBirthdayPhoto(giftId);
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "刪除失敗", "error");
    } finally {
      setUploadingId(null);
    }
  }

  const unrecorded = (people ?? []).filter((p) => !p.gift).length;

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void onPhotoPicked(e.target.files?.[0])}
      />

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-gray-500">當月壽星</h2>
            <p className="mt-1 text-xs text-gray-400">
              到期前三天與當天各發一次通知給 HR；2/29 出生者在平年以 2/28 計。
            </p>
          </div>
          <label className="text-sm text-gray-600">
            月份
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value || monthKey())}
              className="ml-2 inline-block w-40"
            />
          </label>
        </div>

        {error && (
          <div className="mt-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        {people === null ? (
          <Empty>載入中…</Empty>
        ) : people.length === 0 ? (
          <Empty>這個月沒有壽星。</Empty>
        ) : (
          <>
            <p className="mt-3 text-sm text-gray-600">
              共 {people.length} 位
              {unrecorded > 0 ? (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                  {unrecorded} 位尚未登記
                </span>
              ) : (
                <span className="ml-2 text-xs text-green-700">都登記了</span>
              )}
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                    <th className="py-2">姓名</th>
                    <th className="py-2">生日</th>
                    <th className="py-2">歲數</th>
                    <th className="py-2">紅包金額</th>
                    <th className="py-2">發放日</th>
                    <th className="py-2">備註</th>
                    <th className="py-2">照片</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => {
                    const gift = person.gift;
                    return (
                      <tr key={person.employeeId} className="border-b border-gray-100">
                        <td className="py-2 font-medium text-gray-800">{person.name ?? "—"}</td>
                        <td className="py-2 text-gray-600">{birthdayLabel(person)}</td>
                        <td className="py-2 text-gray-600">{person.age ?? "—"}</td>
                        <td className="py-2">{gift ? fmtMoney(gift.amount) : <span className="text-amber-700">未登記</span>}</td>
                        <td className="py-2 text-gray-600">{gift?.given_on ?? "—"}</td>
                        <td className="py-2 text-gray-600">{gift?.note ?? "—"}</td>
                        <td className="py-2">
                          {gift?.photoUrl ? (
                            <span className="flex items-center gap-2">
                              <a
                                href={gift.photoUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                檢視
                              </a>
                              <button
                                type="button"
                                className="text-xs text-gray-500 hover:underline"
                                disabled={uploadingId === gift.id}
                                onClick={() => void removePhoto(gift.id)}
                              >
                                刪除
                              </button>
                            </span>
                          ) : gift ? (
                            <button
                              type="button"
                              className="text-blue-600 hover:underline disabled:opacity-50"
                              disabled={uploadingId === gift.id}
                              onClick={() => pickPhoto(gift.id)}
                            >
                              {uploadingId === gift.id ? "上傳中…" : "拍照上傳"}
                            </button>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <Button variant="secondary" size="sm" onClick={() => openForm(person)}>
                            {gift ? "編輯" : "登記"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-medium text-gray-500">{year} 年度登記</h2>
        {yearGifts === null ? (
          <Empty>載入中…</Empty>
        ) : yearGifts.gifts.length === 0 ? (
          <Empty>今年還沒有任何登記。</Empty>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-600">
              共 {yearGifts.gifts.length} 筆，合計 {fmtMoney(yearGifts.totalAmount)} 元
            </p>
            <ul className="divide-y divide-gray-100 text-sm">
              {yearGifts.gifts.map((gift) => (
                <li key={gift.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-gray-800">{gift.employeeName ?? gift.employee_id.slice(0, 8)}</span>
                  <span className="text-gray-500">
                    {gift.given_on ?? "未填日期"} · {fmtMoney(gift.amount)} 元
                    {gift.photo_path ? " · 有照片" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <BottomSheet
        open={!!form}
        onClose={() => setForm(null)}
        title={form ? `${form.person.name ?? "壽星"} · 生日紅包` : undefined}
      >
        {form && (
          <div className="space-y-4">
            <Field label="金額" hint="可留空（只拍照留存也算登記）">
              <Input
                type="number"
                inputMode="numeric"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>
            <Field label="發放日">
              <Input
                type="date"
                value={form.givenOn}
                onChange={(e) => setForm({ ...form, givenOn: e.target.value })}
              />
            </Field>
            <Field label="備註">
              <Textarea
                rows={2}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </Field>
            <div className="flex gap-2">
              <Button block onClick={() => void save()} loading={saving}>
                儲存
              </Button>
              <Button variant="secondary" block onClick={() => setForm(null)}>
                取消
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>
    </>
  );
}
