import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { errorText } from "../session";
import { cx } from "../utils";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";

export interface TagEditorModalProps {
  open: boolean;
  title: string;
  tags: string[];
  suggestions?: string[];
  /** 单个邮箱最多标签数（与后端一致） */
  max?: number;
  onClose: () => void;
  /** 保存：返回后由调用方刷新 / 关闭；抛错则在本弹窗内展示 */
  onSubmit: (tags: string[]) => Promise<void>;
}

const DEFAULT_SUGGESTIONS = ["已注册 GPT", "已注册 Claude", "已用", "备用", "废弃"];

/**
 * 邮箱标签编辑弹窗：
 * - 输入框回车添加、点 × 删除；
 * - 提供常用建议一键添加；
 * - 保存时把完整标签数组交给 PATCH 接口。
 */
export function TagEditorModal({
  open,
  title,
  tags,
  suggestions = DEFAULT_SUGGESTIONS,
  max = 12,
  onClose,
  onSubmit,
}: TagEditorModalProps): ReactNode {
  const [draft, setDraft] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(tags);
    setInput("");
    setSubmitting(false);
    setError(null);
  }, [open, tags]);

  const addTag = (raw: string): void => {
    const value = raw.trim();
    if (value === "") return;
    if (draft.includes(value)) {
      setInput("");
      return;
    }
    if (draft.length >= max) {
      setError(`最多 ${max} 个标签`);
      return;
    }
    setDraft((prev) => [...prev, value]);
    setInput("");
    setError(null);
  };

  const removeTag = (value: string): void => {
    setDraft((prev) => prev.filter((item) => item !== value));
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag(input);
    } else if (event.key === "Backspace" && input === "" && draft.length > 0) {
      setDraft((prev) => prev.slice(0, -1));
    }
  };

  const close = (): void => {
    if (submitting) return;
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(draft);
    } catch (cause) {
      setError(errorText(cause, "保存标签失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      maxWidth={520}
      closeOnBackdrop={!submitting}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={submitting}>
            取消
          </button>
          <button type="submit" form="tag-editor-form" className="btn btn-primary" disabled={submitting}>
            {submitting ? <Spinner size={16} /> : null}
            保存
          </button>
        </>
      }
    >
      <form id="tag-editor-form" className="form-stack" onSubmit={submit}>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="field">
          <span className="field-label">标签（回车添加，最多 {max} 个）</span>
          <div className="tag-input-box">
            {draft.map((tag) => (
              <span key={tag} className="tag-chip tag-chip-editable">
                {tag}
                <button
                  type="button"
                  className="tag-chip-remove"
                  onClick={() => removeTag(tag)}
                  aria-label={`删除标签 ${tag}`}
                  title="删除"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
            <input
              className="tag-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="输入后回车添加"
              disabled={submitting}
              aria-label="添加标签"
            />
          </div>
        </div>

        <div className="tag-suggest">
          <span className="field-label">常用建议</span>
          <div className="tag-suggest-list">
            {suggestions.map((item) => {
              const used = draft.includes(item);
              return (
                <button
                  key={item}
                  type="button"
                  className={cx("tag-suggest-item", used && "tag-suggest-item-used")}
                  onClick={() => addTag(item)}
                  disabled={submitting || used}
                  title={used ? "已添加" : `添加「${item}」`}
                >
                  {used ? null : <Plus size={12} aria-hidden="true" />}
                  {item}
                </button>
              );
            })}
          </div>
        </div>
      </form>
    </Modal>
  );
}
