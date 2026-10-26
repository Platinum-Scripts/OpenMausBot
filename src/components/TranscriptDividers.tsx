import { t } from "@/lib/i18n";
import { dayLabel } from "@/lib/transcript-derivations";
import { formatTime } from "@/state/store";

export function DaySeparator({ at, today }: { at: number; today: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at, today)} {formatTime(at)}
    </div>
  );
}

/** Where a single chat feed moves from one topic to the next. */
export function TopicDivider({ title }: { title: string }) {
  return (
    <div role="separator" aria-label={t("chat.feed.topicAria", { title })} data-feed-topic="" className="flex items-center gap-3 pt-2 text-[12px] text-ink-tertiary">
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-hairline/60" />
      <span aria-hidden="true" dir="auto" className="max-w-[70%] truncate font-medium">{title}</span>
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-hairline/60" />
    </div>
  );
}

/** A single chat feed whose history did not all load: the lines above are missing until it does. */
export function FeedLoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="status" data-feed-failed="" className="flex items-center justify-center gap-2 py-3 text-[13px] text-ink-secondary">
      <span>{t("chat.feed.loadFailed")}</span>
      <button type="button" onClick={onRetry} className="min-h-11 rounded px-3 text-accent hover:bg-raised">{t("chat.retry")}</button>
    </div>
  );
}
