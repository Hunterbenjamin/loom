import { useRef, useState } from "react";

/** Shared comment field; retain the draft and request identity until submission succeeds. */
export function CommentComposer({
  disabled,
  label,
  placeholder = "Leave a comment…",
  maxLength,
  post,
}: {
  disabled: boolean;
  label: string;
  placeholder?: string;
  maxLength?: number;
  post(body: string, requestId: string): Promise<boolean>;
}) {
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const attempt = useRef<{ body: string; requestId: string } | null>(null);
  const inFlight = useRef(false);
  return (
    <form
      className="pr-comment-box"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || inFlight.current || !comment.trim()) return;
        const body = comment.trim();
        if (attempt.current?.body !== body)
          attempt.current = { body, requestId: crypto.randomUUID() };
        inFlight.current = true;
        setPosting(true);
        try {
          if (await post(body, attempt.current.requestId)) {
            setComment("");
            attempt.current = null;
          }
        } finally {
          inFlight.current = false;
          setPosting(false);
        }
      }}
    >
      <textarea
        aria-label={label}
        placeholder={placeholder}
        value={comment}
        disabled={disabled || posting}
        maxLength={maxLength}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        rows={2}
      />
      <button
        type="submit"
        aria-label="Post comment"
        title="Post comment"
        disabled={disabled || posting || !comment.trim()}
      >
        ↑
      </button>
    </form>
  );
}
