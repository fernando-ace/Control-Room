export function Meter({
  value,
  label,
  tone = "cyan",
}: {
  value: number;
  label: string;
  tone?: string;
}) {
  return (
    <div className="meter">
      <div>
        <span>{label}</span>
        <strong>{Math.round(value)}%</strong>
      </div>
      <div className={"track " + tone}>
        <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}
export function Ship({ alert = false }: { alert?: boolean }) {
  return (
    <div className="ship-grid">
      <svg
        viewBox="0 0 400 240"
        role="img"
        aria-label="Spacecraft system schematic"
      >
        <g fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M180 28L200 12l20 16v55h-40zM175 28h50v42h-50M190 15v68m20-68v68M160 88h80v68h-80zM50 90h80v60H50zM270 90h80v60h-80zM35 105h15v30H35zM350 105h15v30h-15zM130 105h30v30h-30m110-30h30v30h-30M62 90v60m20-60v60m20-60v60m180-60v60m20-60v60m20-60v60M180 156h40v55l-20 17-20-17zM190 156v62m20-62v62" />
          <circle cx="200" cy="122" r="48" />
          <circle cx="200" cy="122" r="36" />
          <circle cx="200" cy="122" r="20" />
          <path d="M200 95v54m-27-27h54" />
        </g>
        <g stroke={alert ? "#ffc15c" : "#45def0"} fill="none" strokeWidth="2">
          <path d="M180 156h40v55l-20 17-20-17z" />
        </g>
      </svg>
      <span>VESSEL / CR-01</span>
    </div>
  );
}
