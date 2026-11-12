const TAG_TONES = ["red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;

export type TagTone = (typeof TAG_TONES)[number];

/** 同一个标签在账号行、筛选栏和编辑页始终显示同一种颜色。 */
export function tagTone(tag: string): TagTone {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) {
    hash = (hash * 31 + tag.charCodeAt(index)) | 0;
  }
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length];
}
