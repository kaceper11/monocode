import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GithubWorkItemDetails, InboxItem } from "../model/githubTasks";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  fetchInboxMedia,
  sniffInboxMedia,
  type InboxMediaType,
} from "../model/inboxMedia";

type Props = {
  src: string;
  alt?: string;
  load?: () => Promise<Uint8Array>;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; url: string; type: InboxMediaType }
  | { status: "error" };

export function InboxMedia({ src, alt, load }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    void (load ? load() : fetchInboxMedia(src))
      .then((bytes) => {
        const type = sniffInboxMedia(bytes);
        if (!type) throw new Error("unsupported");
        const url = URL.createObjectURL(new Blob([bytes], { type: type.mime }));
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setState({ status: "ready", url, type });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, load, retry]);

  if (state.status === "loading") {
    return (
      <span
        className="inbox-media my-2 inline-block h-32 w-full max-w-xl animate-pulse rounded-[10px] border border-content/10 bg-content/6"
        aria-hidden
      />
    );
  }

  if (state.status === "error") {
    if (!load) return <MediaFallback src={src} alt={alt} />;
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <MediaFallback src={src} alt={alt} />
        <button
          type="button"
          className="text-content/55 underline"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry image
        </button>
      </span>
    );
  }

  if (state.type.kind === "video") {
    return (
      <span className="inbox-media my-2 inline-block w-full max-w-xl overflow-hidden rounded-[10px] border border-content/10 bg-content/6">
        <video
          src={state.url}
          controls
          playsInline
          preload="metadata"
          className="block max-h-[28rem] w-full bg-black"
        >
          <MediaFallback src={src} alt={alt} />
        </video>
      </span>
    );
  }

  const label = alt?.trim() || "Image";
  return (
    <img
      src={state.url}
      alt={alt ?? ""}
      title={label}
      draggable={false}
      className="inbox-media my-2 inline-block max-h-[28rem] w-full max-w-xl cursor-zoom-in rounded-[10px] border border-content/10 bg-content/6 object-contain"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void openUrl(src);
      }}
    />
  );
}

export function TicketImages({
  item,
  attachments,
}: {
  item: InboxItem;
  attachments: NonNullable<GithubWorkItemDetails["attachments"]>;
}) {
  const [count, setCount] = useState(4);
  const provider = "Jira";
  const images = attachments.filter((file) =>
    file.mimeType.startsWith("image/"),
  );
  if (!images.length) return null;
  return (
    <section aria-label={`${provider} images`} className="my-4 space-y-2">
      <h3 className="text-[12px] font-medium text-content/55">
        Images · {images.length}
      </h3>
      <div className="grid grid-cols-1 gap-3 min-[1000px]:grid-cols-2">
        {images.slice(0, count).map((file) => (
          <TicketImage key={file.id} item={item} file={file} />
        ))}
      </div>
      {images.length > count && count < 12 ? (
        <button
          type="button"
          className="text-xs text-content/55 underline"
          onClick={() => setCount((value) => value + 4)}
        >
          Show more images
        </button>
      ) : null}
      {images.length > 12 && count >= 12 ? (
        <button
          type="button"
          className="text-xs text-content/55 underline"
          onClick={() => void openUrl(item.url)}
        >
          View remaining images in {provider}
        </button>
      ) : null}
    </section>
  );
}

function TicketImage({
  item,
  file,
}: {
  item: InboxItem;
  file: NonNullable<GithubWorkItemDetails["attachments"]>[number];
}) {
  const load = useCallback(
    async () =>
      new Uint8Array(
        await invoke<ArrayBuffer>("jira_image", {
          site: item.site,
          accountId: item.account ?? "",
          id: item.id,
          attachmentId: file.id,
        }),
      ),
    [item.site, item.account, item.id, file.id],
  );
  return (
    <figure className="min-w-0">
      <InboxMedia src={item.url} alt={file.name} load={load} />
      <figcaption
        className="truncate text-[11px] text-content/45"
        title={file.name}
      >
        {file.name}
      </figcaption>
    </figure>
  );
}

function MediaFallback({ src, alt }: { src: string; alt?: string }) {
  const label = alt?.trim() || src;
  return (
    <a
      href={src}
      className="text-sky-400/90 hover:text-sky-300 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        void openUrl(src);
      }}
    >
      {label}
    </a>
  );
}
