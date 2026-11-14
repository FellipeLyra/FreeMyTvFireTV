// One consistent icon set (24px grid, 1.75 stroke), drawn for the Studio.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
            {children}
        </svg>
    );
}

export const I = {
    Undo: (p: P) => <Svg {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Svg>,
    Redo: (p: P) => <Svg {...p}><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></Svg>,
    Save: (p: P) => <Svg {...p}><path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2Z" /><path d="M8 3v5h7V3M8 21v-6h8v6" /></Svg>,
    Open: (p: P) => <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" /><path d="M3 7v11a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L22 11H7.5a2 2 0 0 0-1.9 1.4L3 20" /></Svg>,
    New: (p: P) => <Svg {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M12 12v6M9 15h6" /></Svg>,
    Export: (p: P) => <Svg {...p}><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></Svg>,
    Send: (p: P) => <Svg {...p}><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></Svg>,
    Play: (p: P) => <Svg {...p}><path d="M7 4v16l13-8z" /></Svg>,
    Edit: (p: P) => <Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></Svg>,
    Remote: (p: P) => <Svg {...p}><rect x="7" y="2" width="10" height="20" rx="5" /><circle cx="12" cy="8" r="2" /><path d="M10 14h4M10 17h4" /></Svg>,
    Tv: (p: P) => <Svg {...p}><rect x="2" y="4" width="20" height="13" rx="2.5" /><path d="M8 21h8" /></Svg>,
    Layers: (p: P) => <Svg {...p}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></Svg>,
    Components: (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><circle cx="17.5" cy="17.5" r="3.5" /></Svg>,
    Image: (p: P) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Svg>,
    Page: (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></Svg>,
    Eye: (p: P) => <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Svg>,
    EyeOff: (p: P) => <Svg {...p}><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6A16.6 16.6 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6" /><path d="m2 2 20 20M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Svg>,
    Lock: (p: P) => <Svg {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>,
    Unlock: (p: P) => <Svg {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></Svg>,
    Trash: (p: P) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" /></Svg>,
    Copy: (p: P) => <Svg {...p}><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></Svg>,
    Plus: (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
    Minus: (p: P) => <Svg {...p}><path d="M5 12h14" /></Svg>,
    Chevron: (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>,
    ChevronDown: (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>,
    Fit: (p: P) => <Svg {...p}><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /></Svg>,
    Grid: (p: P) => <Svg {...p}><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></Svg>,
    Safe: (p: P) => <Svg {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><rect x="5.5" y="7" width="13" height="10" rx="1" strokeDasharray="2 2" /></Svg>,
    StackH: (p: P) => <Svg {...p}><rect x="3" y="6" width="5" height="12" rx="1.2" /><rect x="10" y="6" width="5" height="12" rx="1.2" /><rect x="17" y="6" width="4" height="12" rx="1.2" /></Svg>,
    StackV: (p: P) => <Svg {...p}><rect x="6" y="3" width="12" height="5" rx="1.2" /><rect x="6" y="10" width="12" height="5" rx="1.2" /><rect x="6" y="17" width="12" height="4" rx="1.2" /></Svg>,
    Frame: (p: P) => <Svg {...p}><path d="M7 3v18M17 3v18M3 7h18M3 17h18" /></Svg>,
    Text: (p: P) => <Svg {...p}><path d="M5 6V4h14v2M12 4v16M9 20h6" /></Svg>,
    Button: (p: P) => <Svg {...p}><rect x="3" y="7" width="18" height="10" rx="5" /><path d="M9 12h6" /></Svg>,
    Clock: (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>,
    Spacer: (p: P) => <Svg {...p}><path d="M4 4v16M20 4v16M8 12h8M8 12l2-2M8 12l2 2M16 12l-2-2M16 12l-2 2" /></Svg>,
    Divider: (p: P) => <Svg {...p}><path d="M3 12h18" /><path d="M8 7h8M8 17h8" opacity=".4" /></Svg>,
    Widget: (p: P) => <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 15h3M7 9h10" /><circle cx="16" cy="14.5" r="1.5" /></Svg>,
    Warning: (p: P) => <Svg {...p}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></Svg>,
    Error: (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></Svg>,
    Check: (p: P) => <Svg {...p}><path d="m5 12 5 5L20 7" /></Svg>,
    Palette: (p: P) => <Svg {...p}><path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.5-1.5-1.5-1.5-3S13 14 14.5 14H17a4 4 0 0 0 4-4c0-3.9-4-7-9-7Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></Svg>,
    AlignLeft: (p: P) => <Svg {...p}><path d="M4 3v18" /><rect x="7" y="6" width="12" height="4" rx="1" /><rect x="7" y="14" width="7" height="4" rx="1" /></Svg>,
    AlignHCenter: (p: P) => <Svg {...p}><path d="M12 3v18" /><rect x="5" y="6" width="14" height="4" rx="1" /><rect x="8" y="14" width="8" height="4" rx="1" /></Svg>,
    AlignRight: (p: P) => <Svg {...p}><path d="M20 3v18" /><rect x="5" y="6" width="12" height="4" rx="1" /><rect x="10" y="14" width="7" height="4" rx="1" /></Svg>,
    AlignTop: (p: P) => <Svg {...p}><path d="M3 4h18" /><rect x="6" y="7" width="4" height="12" rx="1" /><rect x="14" y="7" width="4" height="7" rx="1" /></Svg>,
    AlignVCenter: (p: P) => <Svg {...p}><path d="M3 12h18" /><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="8" width="4" height="8" rx="1" /></Svg>,
    AlignBottom: (p: P) => <Svg {...p}><path d="M3 20h18" /><rect x="6" y="5" width="4" height="12" rx="1" /><rect x="14" y="10" width="4" height="7" rx="1" /></Svg>,
    DistH: (p: P) => <Svg {...p}><path d="M4 3v18M20 3v18" /><rect x="9" y="7" width="6" height="10" rx="1" /></Svg>,
    DistV: (p: P) => <Svg {...p}><path d="M3 4h18M3 20h18" /><rect x="7" y="9" width="10" height="6" rx="1" /></Svg>,
    Upload: (p: P) => <Svg {...p}><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></Svg>,
    Close: (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>,
};

export function iconForType(type: string) {
    switch (type) {
        case 'stack': return I.StackH;
        case 'frame': return I.Frame;
        case 'text': return I.Text;
        case 'image': return I.Image;
        case 'button': return I.Button;
        case 'clock-text': return I.Clock;
        case 'spacer': return I.Spacer;
        case 'divider': return I.Divider;
        default: return I.Widget;
    }
}
