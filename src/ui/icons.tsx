// Inline SVG icons (20x20 solid style).

type IconProps = { className?: string };

function Svg({ className = "h-4 w-4", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.25v3.25a.75.75 0 0 0 1.5 0V9.75A.75.75 0 0 0 10 9H9Z"
      clipRule="evenodd"
    />
  </Svg>
);

export const GripIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM16 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM16 16a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
  </Svg>
);

export const UpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M10 4a.75.75 0 0 1 .53.22l5 5a.75.75 0 1 1-1.06 1.06L10.75 6.56V15.5a.75.75 0 0 1-1.5 0V6.56L5.53 10.28a.75.75 0 0 1-1.06-1.06l5-5A.75.75 0 0 1 10 4Z"
      clipRule="evenodd"
    />
  </Svg>
);

export const DownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M10 16a.75.75 0 0 1-.53-.22l-5-5a.75.75 0 1 1 1.06-1.06l3.72 3.72V4.5a.75.75 0 0 1 1.5 0v8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-5 5A.75.75 0 0 1 10 16Z"
      clipRule="evenodd"
    />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
  </Svg>
);
