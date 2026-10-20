type IconProps = {
  size?: number;
  class?: string;
};

export function IconArrowUpRight({ size = 14, class: className }: IconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 12L12 4M5.5 4H12V10.5" stroke="currentColor" stroke-width="1.4" />
    </svg>
  );
}

export function IconArrowRight({ size = 16, class: className }: IconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 10h13M11 5l5 5-5 5" stroke="currentColor" stroke-width="1.3" />
    </svg>
  );
}

export function IconArrowLeft({ size = 16, class: className }: IconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M17 10H4M9 5l-5 5 5 5" stroke="currentColor" stroke-width="1.3" />
    </svg>
  );
}

export function IconBookmark({ size = 15, filled = false, class: className }: IconProps & { filled?: boolean }) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 16 18"
      fill={filled ? "currentColor" : "none"}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3.5 2.2h9a1 1 0 0 1 1 1v12.4l-5.5-3.4-5.5 3.4V3.2a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function IconLink({ size = 15, class: className }: IconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7.2 10.8 10.8 7.2M6.4 12.9l-1 .9a3.2 3.2 0 0 1-4.5-4.5l2.3-2.3a3.2 3.2 0 0 1 4.5 0M11.6 5.1l1-.9a3.2 3.2 0 0 1 4.5 4.5l-2.3 2.3a3.2 3.2 0 0 1-4.5 0"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function IconCheck({ size = 14, class: className }: IconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m3 8.5 3.2 3.2L13 5" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

export function IconMinus({ size = 14, class: className }: IconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8h10" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

export function IconQuote({ size = 18, class: className }: IconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 12.5c0-4 1.7-6.2 4.7-7.8l.7 1.3c-1.5.9-2.4 2-2.7 3.2h2v4.8H3v-1.5Zm9 0c0-4 1.7-6.2 4.7-7.8l.7 1.3c-1.5.9-2.4 2-2.7 3.2h2v4.8h-4.7v-1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
