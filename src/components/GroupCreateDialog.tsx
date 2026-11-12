import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { ModalShell } from "./ModalShell";

export function GroupCreateDialog({
  categoryLabel,
  onClose,
  onCreate
}: {
  categoryLabel: string;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请输入分组名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onCreate(trimmed);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="新建分组"
      subtitle={`分组会出现在「${categoryLabel}」的标签页中`}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondary-button dark-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button dark-primary" disabled={busy}>
            <Plus size={15} /> {busy ? "创建中…" : "创建分组"}
          </button>
        </>
      }
    >
      <label className="stacked-label">
        分组名称
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：客户邮箱、临时邮箱、项目 A"
          maxLength={100}
        />
      </label>
      {error ? <div className="error-box">{error}</div> : null}
    </ModalShell>
  );
}
