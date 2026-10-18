// Ported from old_repo/src/components/community/Post.tsx (lines 505-591)
// Ported from old_repo/src/components/community/CouncilMembersRail.tsx (lines 203-259)
// Ported from old_repo/src/components/community/CommunitySidebar.tsx (lines 694-745)
// Ported from old_repo/src/components/community/GroupModals.tsx (lines 1038-1091)
// The one avatar (seven copies with seven initials rules): a headshot, else the initials (first and last word's first letters), and for an anonymous author a neutral glyph that is never derived from a name or a photo.
import styles from "../community.module.css";

export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] as string;
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${(parts[parts.length - 1] as string)[0] ?? ""}`.toUpperCase();
}

export function Avatar({ name, url, size = 36, neutral = false }: { name?: string | null; url?: string | null; size?: number; neutral?: boolean }) {
  const box = { width: size, height: size };
  if (neutral) {
    return (
      <span aria-hidden="true" className={`${styles.avatar} ${styles.avatarNeutral}`} style={box}>
        ●
      </span>
    );
  }
  if (url) {
    // An arbitrary external headshot address: next/image would need every possible host configured.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={size} height={size} className={styles.avatarImage} style={box} />;
  }
  return (
    <span aria-hidden="true" className={styles.avatar} style={box}>
      {initialsOf(name)}
    </span>
  );
}
