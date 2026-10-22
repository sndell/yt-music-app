import { useState, type ReactNode, type Ref } from "react";
import { cn } from "@/util/cn";
import { hexToRgba } from "@/util/hex_to_rgba";
import { PlaylistDescription } from "@/features/playlist/components/PlaylistDescription";

type MetaPart = ReactNode | string | null | false | undefined;

export type CollectionHeaderProps = {
  /** Small line above the title. */
  eyebrow: string;
  title: string;
  /**
   * `cover` is the square artwork beside the text (playlist, album).
   * `banner` is the wide artist image.
   */
  layout?: "cover" | "banner";
  artworkUrl?: string;
  artworkAlt?: string;
  /** Rendered with show more / show less. Skipped when empty unless a placeholder is allowed. */
  description?: string | null;
  descriptionPlaceholder?: boolean;
  meta?: MetaPart[];
  actions?: ReactNode;
  dominantColor?: string | null;
  headerRef?: Ref<HTMLDivElement>;
};

const Artwork = ({
  url,
  alt,
  className,
  iconClass = "text-4xl",
}: {
  url?: string;
  alt: string;
  className: string;
  iconClass?: string;
}) => {
  const [failed, setFailed] = useState(false);

  if (url && !failed) {
    return <img src={url} alt={alt} onError={() => setFailed(true)} className={cn("object-cover", className)} />;
  }

  return (
    <div className={cn("grid place-items-center bg-primary-light text-primary-dark", className)}>
      <span className={cn("icon-[solar--music-note-linear]", iconClass)} />
    </div>
  );
};

const Eyebrow = ({ children, className }: { children: ReactNode; className?: string }) => (
  <p className={cn("text-[11px] font-medium tracking-[0.2em] uppercase", className)}>{children}</p>
);

export const CollectionMeta = ({ parts, className }: { parts: MetaPart[]; className?: string }) => {
  const visible = parts.filter((part) => part != null && part !== false && part !== "");
  if (visible.length === 0) return null;

  return (
    <p className={cn("flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-white/75", className)}>
      {visible.map((part, index) => (
        <span key={index} className="inline-flex min-w-0 items-center gap-2">
          {index > 0 && (
            <span aria-hidden="true" className="text-sm leading-none text-white/40">
              ·
            </span>
          )}
          {part}
        </span>
      ))}
    </p>
  );
};

const Description = ({
  description,
  placeholder,
}: {
  description?: string | null;
  placeholder: boolean;
}) => {
  if (!description?.trim() && !placeholder) return null;
  return (
    <div className="max-w-3xl">
      <PlaylistDescription description={description ?? ""} tone="light" />
    </div>
  );
};

export const CollectionHeader = ({ layout = "cover", ...props }: CollectionHeaderProps) => {
  const {
    eyebrow,
    title,
    artworkUrl,
    artworkAlt,
    description,
    descriptionPlaceholder,
    meta,
    actions,
    dominantColor,
    headerRef,
  } = props;
  const color = dominantColor ?? null;

  if (layout === "banner") {
    return (
      <div ref={headerRef} className="relative overflow-hidden">
        <Artwork
          key={artworkUrl ?? "missing"}
          url={artworkUrl}
          alt=""
          className="absolute inset-0 size-full object-[center_28%]"
          iconClass="text-5xl"
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-linear-to-t from-black via-black/45 to-black/15" />
        {color && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 mix-blend-soft-light"
            style={{ background: hexToRgba(color, 0.55) }}
          />
        )}
        <div className="relative flex min-h-72 flex-col justify-end px-5 pt-32 pb-7 text-shadow-[0_2px_20px_rgb(0_0_0/0.65)] @2xl:min-h-96 @2xl:px-8">
          <Eyebrow className="text-white/60">{eyebrow}</Eyebrow>
          <h1
            title={title}
            className="mt-2 line-clamp-3 min-w-0 max-w-full text-5xl leading-[0.95] font-black tracking-[-0.045em] wrap-break-word @lg:text-6xl @2xl:text-7xl"
          >
            {title}
          </h1>
          {meta && meta.length > 0 && (
            <div className="pt-3">
              <CollectionMeta parts={meta} className="text-sm" />
            </div>
          )}
          {actions && <div className="pt-6">{actions}</div>}
        </div>
      </div>
    );
  }

  const block = color
    ? `linear-gradient(165deg, ${hexToRgba(color, 0.92)} 0%, ${hexToRgba(color, 0.5)} 48%, ${hexToRgba(color, 0.1)} 100%)`
    : "linear-gradient(165deg, rgb(255 255 255 / 0.08), rgb(255 255 255 / 0.02))";

  return (
    <div ref={headerRef} className="relative overflow-hidden px-5 pt-9 pb-8 @2xl:px-8" style={{ background: block }}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-linear-to-b from-black/15 to-black/25" />
      <div className="relative flex flex-col gap-6 @lg:flex-row @lg:items-end @lg:gap-8">
        <Artwork
          key={artworkUrl ?? "missing"}
          url={artworkUrl}
          alt={artworkAlt ?? title}
          className="size-44 shrink-0 rounded-xl shadow-[0_30px_80px_-24px_rgb(0_0_0/0.95)] ring-1 ring-white/20 @lg:size-52 @2xl:size-64"
        />
        <div className="min-w-0 flex-1 pb-0.5">
          <Eyebrow className="text-white/60">{eyebrow}</Eyebrow>
          <h1
            title={title}
            className="mt-2 line-clamp-3 min-w-0 max-w-full text-4xl leading-[0.98] font-black tracking-[-0.04em] wrap-break-word @lg:text-6xl @2xl:text-7xl"
          >
            {title}
          </h1>
          <Description description={description} placeholder={descriptionPlaceholder ?? false} />
          {meta && meta.length > 0 && (
            <div className="pt-3 text-shadow-[0_1px_12px_rgb(0_0_0/0.5)]">
              <CollectionMeta parts={meta} className="text-sm" />
            </div>
          )}
          {actions && <div className="pt-6">{actions}</div>}
        </div>
      </div>
    </div>
  );
};
