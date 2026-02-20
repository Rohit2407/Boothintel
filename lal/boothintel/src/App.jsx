import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BACKEND_URL = "http://localhost:5001";

const STATUS_CONFIG = {
  "Not Visited": { color: "#94a3b8", bg: "#1e293b", dot: "#475569" },
  "Visited":     { color: "#34d399", bg: "#022c22", dot: "#10b981" },
  "Follow-up":   { color: "#fbbf24", bg: "#2d1a00", dot: "#f59e0b" },
  "Unreachable": { color: "#f87171", bg: "#2d0000", dot: "#ef4444" },
};

const RELATION_COLORS = {
  "S/O": "#60a5fa", "D/O": "#f472b6", "W/O": "#a78bfa",
  "H/O": "#34d399", "C/O": "#fb923c", "F/O": "#94a3b8",
};

// ─── DATA PROCESSING ──────────────────────────────────────────────────────────

function norm(s) { return String(s ?? "").trim().toUpperCase(); }
function normHouse(h) { return norm(h).replace(/\s+/g, ""); }

function findCol(keys, ...candidates) {
  for (const c of candidates) {
    const k = keys.find(k => norm(k).includes(norm(c)));
    if (k !== undefined) return k;
  }
  return null;
}

function parseRelationType(raw) {
  const s = norm(raw);

  if (s.includes("WIFE") || s.includes("W/O")) return "W/O";
  if (s.includes("DAUGHTER") || s.includes("D/O")) return "D/O";
  if (s.includes("SON") || s.includes("S/O") || s.includes("FATHER")) return "S/O";

  // Anything else → treat as S/O (default in rolls)
  return "S/O";
}


function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const set = new Set(a.split(" "));
  const bWords = b.split(" ");
  const matches = bWords.filter(w => set.has(w) && w.length > 2).length;
  return matches / Math.max(a.split(" ").length, b.split(" ").length);
}

function parseSheetRows(rows, boothName) {
  if (!rows || rows.length === 0) return [];
  const keys = Object.keys(rows[0]);
  const colName     = findCol(keys, "voter name", "name", "full name");
  const colRelName  = findCol(keys, "relation name", "father name", "husband name", "mother name", "relative name", "guardian");
  const colRelType  = findCol(keys, "relation type", "rel type", "relationship");
  const colAge      = findCol(keys, "age");
  const colGender   = findCol(keys, "gender", "sex");
  const colHouse    = findCol(keys, "house no", "house number", "h.no", "hno", "door no", "house");
  const colEpic     = findCol(keys, "epic", "voter id", "voter card", "card no");
  const colSerial   = findCol(keys, "serial", "s.no", "sno", "sr no", "sl no");

  return rows
    .filter(r => colName && norm(r[colName]))
    .map((r, idx) => ({
      id: `${boothName}_${idx}`,
      serial: norm(r[colSerial] ?? idx + 1),
      name: norm(r[colName]),
      relationName: norm(r[colRelName] ?? ""),
      relationType: parseRelationType(r[colRelType] ?? ""),
      age: parseInt(r[colAge]) || 0,
      gender: norm(r[colGender] ?? "").charAt(0) || "?",
      houseNo: normHouse(r[colHouse] ?? ""),
      epic: norm(r[colEpic] ?? ""),
      booth: boothName,
      visitStatus: "Not Visited",
      lastVisitDate: null,
      notes: "",
    }));
}

function parsePipelineCSV(csvText, fallbackBoothName = "Booth") {
  const lines = csvText.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const parseRow = (line) => {
    const result = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { result.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    result.push(cur.trim());
    return result;
  };

  const header = parseRow(lines[0]).map(h => h.toLowerCase().trim());
  const ci = (name) => header.indexOf(name);
  const iVoterId = ci("voter_id"), iName = ci("name"), iRelType = ci("relation_type");
  const iRelName = ci("relation_name"), iHouseNo = ci("house_number"), iAge = ci("age");
  const iGender = ci("gender"), iPartNo = ci("part_no"), iSection = ci("section");

  const voters = [];
  lines.slice(1).forEach((line, idx) => {
    const r = parseRow(line);
    if (!r[iName] || r[iName].length < 2) return;
    const partNo = r[iPartNo] ? `Part ${r[iPartNo]}` : fallbackBoothName;
    const relTypeRaw = r[iRelType] || "";
    let relType = "—";
    if (/father/i.test(relTypeRaw)) relType = "S/O";
    else if (/husband/i.test(relTypeRaw)) relType = "W/O";
    else if (/mother/i.test(relTypeRaw)) relType = "C/O";
    else if (relTypeRaw) relType = relTypeRaw.toUpperCase();

    voters.push({
      id: `PIPE_${idx}`,
      serial: String(idx + 1),
      name: norm(r[iName]),
      relationName: norm(r[iRelName] ?? ""),
      relationType: relType,
      age: parseInt(r[iAge]) || 0,
      gender: norm(r[iGender] ?? "").charAt(0) || "?",
      houseNo: normHouse(r[iHouseNo] ?? ""),
      epic: norm(r[iVoterId] ?? ""),
      booth: partNo,
      visitStatus: "Not Visited",
      lastVisitDate: null,
      notes: "",
      section: r[iSection] || "",
    });
  });
  return voters;
}

function dedup(voters) {
  const epicSeen = new Set();
  return voters.filter(v => {
    if (!v.epic) return true;
    if (epicSeen.has(v.epic)) return false;
    epicSeen.add(v.epic);
    return true;
  });
}

function buildHouseholds(voters) {
  const map = {};
  voters.forEach(v => {
    const key = `${v.booth}||${v.houseNo || "__x_" + v.id}`;
    if (!map[key]) map[key] = { key, booth: v.booth, houseNo: v.houseNo, members: [] };
    map[key].members.push(v);
  });
  return Object.values(map).map(h => {
  h.members.sort((a, b) => (b.age || 0) - (a.age || 0));
  h.head = h.members[0];
  h.links = buildLinks(h.members);

  // NEW — Suspicious household detection
  const suspicious = detectSuspicious(h);
  h.sus_flag = suspicious.sus_flag;
  h.sus_score = suspicious.sus_score;
  h.sus_reasons = suspicious.sus_reasons;

  return h;
});

}

function buildLinks(members) {
  const links = [];
  members.forEach(m => {
    if (!m.relationName) return;
    const match = members.find(o => o.id !== m.id && similarity(o.name, m.relationName) >= 0.6);
    if (match) links.push({ from: match.id, to: m.id, type: m.relationType });
  });
  return links;
}

// ─── FAMILY TREE BUILDER ─────────────────────────────────────────────────────

/**
 * buildFamilyTree
 * Constructs a tree structure from a household's members + links.
 * Returns { root, nodes: Map<id, node>, edges: [{from, to, type}] }
 *
 * Strategy:
 *   1. Build adjacency from links (from = parent, to = child)
 *   2. Find root = node with no incoming edge (oldest if tie)
 *   3. BFS to assign levels + positions
 */
function buildFamilyTree(members, links) {
  if (!members.length) return null;

  // Map id → member
  const byId = {};
  members.forEach(m => { byId[m.id] = m; });

  // Build parent → [children] from links
  const children = {};
  const hasParent = new Set();
  members.forEach(m => { children[m.id] = []; });

  links.forEach(l => {
    if (byId[l.from] && byId[l.to]) {
      children[l.from] = children[l.from] || [];
      children[l.from].push({ id: l.to, type: l.type });
      hasParent.add(l.to);
    }
  });

  // Root candidates = members with no parent in link graph
  let roots = members.filter(m => !hasParent.has(m.id));
  if (!roots.length) roots = [members[0]]; // fallback

  // Pick oldest as primary root
  roots.sort((a, b) => (b.age || 0) - (a.age || 0));
  const rootId = roots[0].id;

  // BFS to build levels
  const levels = {};
  const queue = [{ id: rootId, level: 0 }];
  const visited = new Set([rootId]);

  while (queue.length) {
    const { id, level } = queue.shift();
    levels[id] = level;
    (children[id] || []).forEach(({ id: cid }) => {
      if (!visited.has(cid)) {
        visited.add(cid);
        queue.push({ id: cid, level: level + 1 });
      }
    });
  }

  // Add unvisited members at deepest level + 1
  members.forEach(m => {
    if (levels[m.id] === undefined) levels[m.id] = Math.max(...Object.values(levels), 0) + 1;
  });

  // Group by level
  const byLevel = {};
  Object.entries(levels).forEach(([id, lvl]) => {
    byLevel[lvl] = byLevel[lvl] || [];
    byLevel[lvl].push(id);
  });

  // Assign x/y positions
  const NODE_W = 140, NODE_H = 76, H_GAP = 30, V_GAP = 80;
  const positions = {};
  const maxLevel = Math.max(...Object.keys(byLevel).map(Number));

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const ids = byLevel[lvl] || [];
    const totalW = ids.length * NODE_W + (ids.length - 1) * H_GAP;
    ids.forEach((id, i) => {
      positions[id] = {
        x: i * (NODE_W + H_GAP) - totalW / 2 + NODE_W / 2,
        y: lvl * (NODE_H + V_GAP),
      };
    });
  }

  return {
    rootId,
    positions,
    children,
    byLevel,
    maxLevel,
    byId,
    links,
    totalH: (maxLevel + 1) * (NODE_H + V_GAP),
  };
}

// ─── FAMILY TREE COMPONENT ───────────────────────────────────────────────────

const NODE_W = 140, NODE_H = 76;

function FamilyTreeNode({ member, pos, isSelected, onClick }) {
  const sc = STATUS_CONFIG[member.visitStatus] || STATUS_CONFIG["Not Visited"];
  const isF = member.gender === "F";
  const initials = member.name.split(" ").slice(0, 2).map(w => w[0]).join("");

  return (
    <g
      transform={`translate(${pos.x - NODE_W / 2}, ${pos.y - NODE_H / 2})`}
      onClick={() => onClick(member.id)}
      style={{ cursor: "pointer" }}
    >
      {/* Card shadow */}
      <rect x="3" y="4" width={NODE_W} height={NODE_H} rx="10" fill="rgba(0,0,0,0.4)" />
      {/* Card bg */}
      <rect
        width={NODE_W} height={NODE_H} rx="10"
        fill={isSelected ? (isF ? "#2d1052" : "#0c2d5a") : "#0f172a"}
        stroke={isSelected ? (isF ? "#a855f7" : "#3b82f6") : sc.color + "60"}
        strokeWidth={isSelected ? 2 : 1}
      />
      {/* Top accent bar */}
      <rect width={NODE_W} height="4" rx="10" fill={isF ? "#a855f7" : "#3b82f6"} opacity="0.7" />
      {/* Avatar circle */}
      <circle cx="26" cy="38" r="16" fill={isF ? "#4a044e" : "#0c2a4a"} stroke={isF ? "#a855f7" : "#3b82f6"} strokeWidth="1.5" />
      <text x="26" y="43" textAnchor="middle" fill={isF ? "#d8b4fe" : "#93c5fd"} fontSize="10" fontWeight="800" fontFamily="monospace">
        {initials}
      </text>
      {/* Name */}
      <text x="50" y="28" fill="#f1f5f9" fontSize="10" fontWeight="700" fontFamily="monospace">
        {member.name.length > 14 ? member.name.slice(0, 13) + "…" : member.name}
      </text>
      {/* Age + gender */}
      <text x="50" y="42" fill="#64748b" fontSize="9" fontFamily="monospace">
        {member.age}y · {isF ? "Female" : "Male"}
      </text>
      {/* Relation */}
      {member.relationType !== "—" && (
        <text x="50" y="55" fill={RELATION_COLORS[member.relationType] || "#94a3b8"} fontSize="8.5" fontFamily="monospace">
          {member.relationType} {member.relationName?.slice(0, 10)}
        </text>
      )}
      {/* Status dot */}
      <circle cx={NODE_W - 10} cy="10" r="5" fill={sc.dot} />
    </g>
  );
}

function FamilyTreeEdge({ from, to, type, positions }) {
  const fp = positions[from], tp = positions[to];
  if (!fp || !tp) return null;
  const color = RELATION_COLORS[type] || "#334155";

  // Cubic bezier from bottom of parent to top of child
  const x1 = fp.x, y1 = fp.y + NODE_H / 2;
  const x2 = tp.x, y2 = tp.y - NODE_H / 2;
  const cy = (y1 + y2) / 2;

  return (
    <g>
      <path
        d={`M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray="4 3"
        opacity="0.6"
      />
      {/* Arrow head */}
      <polygon
        points={`${x2},${y2} ${x2 - 4},${y2 - 8} ${x2 + 4},${y2 - 8}`}
        fill={color}
        opacity="0.6"
      />
      {/* Label */}
      <text
        x={(x1 + x2) / 2 + 6}
        y={(y1 + y2) / 2}
        fill={color}
        fontSize="8"
        fontFamily="monospace"
        opacity="0.9"
      >
        {type}
      </text>
    </g>
  );
}

function FamilyTreeView({ household }) {
  const [selectedId, setSelectedId] = useState(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const svgRef = useRef(null);

  const tree = useMemo(() => buildFamilyTree(household.members, household.links), [household]);

  useEffect(() => {
    // Center the tree initially
    if (tree) {
      setPan({ x: 0, y: 40 });
    }
  }, [tree]);

  const selected = selectedId ? tree?.byId[selectedId] : null;

  const handleMouseDown = (e) => {
    if (e.target.closest("g[data-node]")) return;
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };
  const handleMouseMove = (e) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };
  const handleMouseUp = () => { dragging.current = false; };

  const handleWheel = (e) => {
    e.preventDefault();
    setZoom(z => Math.min(2, Math.max(0.3, z - e.deltaY * 0.001)));
  };

  if (!tree) return (
    <div style={{ textAlign: "center", color: "#334155", padding: 60, fontFamily: "monospace" }}>
      No family data available for this household.
    </div>
  );

  const svgW = 900, svgH = 520;
  const centerX = svgW / 2, centerY = 60;

  return (
    <div style={{ display: "flex", gap: 16, height: 560 }}>
      {/* SVG canvas */}
      <div
        style={{ flex: 1, background: "#060d1a", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden", position: "relative", cursor: "grab" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Toolbar */}
        <div style={{ position: "absolute", top: 12, right: 12, zIndex: 10, display: "flex", gap: 6 }}>
          {[
            { label: "+", action: () => setZoom(z => Math.min(2, z + 0.15)) },
            { label: "−", action: () => setZoom(z => Math.max(0.3, z - 0.15)) },
            { label: "⊙", action: () => { setZoom(1); setPan({ x: 0, y: 40 }); } },
          ].map(({ label, action }) => (
            <button key={label} onClick={action} style={{
              background: "#0f172a", border: "1px solid #1e293b", borderRadius: 6,
              color: "#64748b", width: 28, height: 28, cursor: "pointer", fontSize: 14, lineHeight: 1,
            }}>{label}</button>
          ))}
        </div>

        {/* Legend */}
        <div style={{ position: "absolute", top: 12, left: 12, zIndex: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {Object.entries(RELATION_COLORS).map(([type, color]) => (
            <span key={type} style={{ fontSize: 10, color, fontFamily: "monospace", background: "#0f172a", padding: "2px 7px", borderRadius: 99, border: `1px solid ${color}40` }}>
              {type}
            </span>
          ))}
        </div>

        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${svgW} ${svgH}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ userSelect: "none" }}
        >
          <defs>
            <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
              <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#0f172a" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width={svgW} height={svgH} fill="url(#grid)" />

          <g transform={`translate(${centerX + pan.x}, ${centerY + pan.y}) scale(${zoom})`}>
            {/* Edges */}
            {tree.links.map((l, i) => (
              <FamilyTreeEdge
                key={i}
                from={l.from}
                to={l.to}
                type={l.type}
                positions={tree.positions}
              />
            ))}
            {/* Nodes */}
            {tree.members
              ? null
              : null}
            {Object.keys(tree.positions).map(id => (
              <g key={id} data-node="true">
                <FamilyTreeNode
                  member={tree.byId[id]}
                  pos={tree.positions[id]}
                  isSelected={selectedId === id}
                  onClick={id => setSelectedId(prev => prev === id ? null : id)}
                />
              </g>
            ))}
          </g>
        </svg>

        <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", color: "#1e293b", fontSize: 11, fontFamily: "monospace", pointerEvents: "none" }}>
          drag to pan · scroll to zoom · click node to inspect
        </div>
      </div>

      {/* Side panel — selected voter details */}
      <div style={{ width: 220, background: "#0f172a", borderRadius: 12, border: "1px solid #1e293b", padding: 16, overflowY: "auto", flexShrink: 0 }}>
        <div style={{ color: "#334155", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 14 }}>
          {selected ? "Member Details" : "Household"}
        </div>

        {!selected ? (
          <>
            <div style={{ color: "#f1f5f9", fontWeight: 800, fontFamily: "monospace", fontSize: 15, marginBottom: 4 }}>
              House {household.houseNo || "—"}
            </div>
            <div style={{ color: "#475569", fontSize: 12, marginBottom: 16 }}>{household.members.length} members</div>
            {household.members.map(m => {
              const sc = STATUS_CONFIG[m.visitStatus];
              return (
                <div
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 5, cursor: "pointer", background: "#060d1a", border: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 8 }}
                >
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.gender === "F" ? "#4a044e" : "#0c2a4a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: m.gender === "F" ? "#d8b4fe" : "#93c5fd", flexShrink: 0 }}>
                    {m.name.split(" ").slice(0, 2).map(w => w[0]).join("")}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#f1f5f9", fontSize: 11, fontFamily: "monospace", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                    <div style={{ color: "#475569", fontSize: 10 }}>{m.age}y · {m.gender === "F" ? "F" : "M"}</div>
                  </div>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc?.dot, flexShrink: 0 }} />
                </div>
              );
            })}
          </>
        ) : (
          <>
            <button onClick={() => setSelectedId(null)} style={{ background: "none", border: "1px solid #1e293b", borderRadius: 6, color: "#64748b", fontSize: 11, padding: "3px 8px", cursor: "pointer", marginBottom: 14, fontFamily: "monospace" }}>
              ← Back
            </button>

            <div style={{ width: 56, height: 56, borderRadius: "50%", background: selected.gender === "F" ? "#4a044e" : "#0c2a4a", border: `2px solid ${selected.gender === "F" ? "#a855f7" : "#3b82f6"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: selected.gender === "F" ? "#d8b4fe" : "#93c5fd", margin: "0 auto 14px" }}>
              {selected.name.split(" ").slice(0, 2).map(w => w[0]).join("")}
            </div>

            <div style={{ color: "#f1f5f9", fontWeight: 800, fontFamily: "monospace", fontSize: 14, textAlign: "center", marginBottom: 4 }}>{selected.name}</div>

            {[
              ["Age", selected.age + " yrs"],
              ["Gender", selected.gender === "F" ? "Female" : "Male"],
              ["Relation", `${selected.relationType} ${selected.relationName}`],
              ["Status", selected.visitStatus],
              ["EPIC", selected.epic || "—"],
              ["House", selected.houseNo || "—"],
              ...(selected.notes ? [["Notes", selected.notes]] : []),
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #1e293b" }}>
                <span style={{ color: "#475569", fontSize: 11, fontFamily: "monospace" }}>{k}</span>
                <span style={{ color: "#94a3b8", fontSize: 11, fontFamily: "monospace", textAlign: "right", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
              </div>
            ))}

            {/* Family connections */}
            {(() => {
              const conns = household.links.filter(l => l.from === selected.id || l.to === selected.id);
              if (!conns.length) return null;
              return (
                <div style={{ marginTop: 14 }}>
                  <div style={{ color: "#334155", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 8 }}>Connections</div>
                  {conns.map((l, i) => {
                    const otherId = l.from === selected.id ? l.to : l.from;
                    const other = tree.byId[otherId];
                    const color = RELATION_COLORS[l.type] || "#94a3b8";
                    return (
                      <div key={i} onClick={() => setSelectedId(otherId)} style={{ padding: "6px 8px", borderRadius: 7, marginBottom: 4, cursor: "pointer", background: "#060d1a", border: `1px solid ${color}30`, display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color, fontSize: 10, fontFamily: "monospace", minWidth: 30 }}>{l.type}</span>
                        <span style={{ color: "#94a3b8", fontSize: 11, fontFamily: "monospace" }}>{other?.name}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

// ─── HOUSEHOLD FAMILY TREE MODAL ──────────────────────────────────────────────

function FamilyTreeModal({ household, onClose }) {
  useEffect(() => {
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#060d1a", border: "1px solid #1e293b", borderRadius: 16, width: "100%", maxWidth: 1100, maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 18 }}>🌳</span>
          <div>
            <div style={{ color: "#f1f5f9", fontFamily: "monospace", fontWeight: 800, fontSize: 16 }}>
              Family Tree — House {household.houseNo || "?"}
            </div>
            <div style={{ color: "#475569", fontSize: 12 }}>{household.members.length} members · {household.links.length} connections detected</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "#1e293b", border: "1px solid #334155", borderRadius: 8, color: "#64748b", padding: "6px 14px", cursor: "pointer", fontSize: 13, fontFamily: "monospace" }}>
            ✕ Close
          </button>
        </div>
        {/* Tree */}
        <div style={{ padding: 20, flex: 1, overflowY: "auto" }}>
          <FamilyTreeView household={household} />
        </div>
      </div>
    </div>
  );
}

// ─── BOOTH-WIDE FAMILY TREE VIEW ──────────────────────────────────────────────

function BoothFamilyTreePanel({ households }) {
  const [selectedHH, setSelectedHH] = useState(null);
  const [modalHH, setModalHH] = useState(null);

  const linked = households.filter(hh => hh.links.length > 0);
  const unlinked = households.filter(hh => hh.links.length === 0);

  const displayHH = selectedHH || (linked[0] || households[0]);

  return (
    <div style={{ display: "flex", gap: 20 }}>
      {/* Household list sidebar */}
      <div style={{ width: 220, flexShrink: 0 }}>
        <div style={{ color: "#334155", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 10 }}>
          Households ({households.length})
        </div>

        {linked.length > 0 && (
          <>
            <div style={{ color: "#1e3a5f", fontSize: 9, letterSpacing: 1, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 6 }}>
              With Family Links
            </div>
            {linked.map(hh => (
              <div
                key={hh.key}
                onClick={() => setSelectedHH(hh)}
                style={{
                  padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 4,
                  background: displayHH?.key === hh.key ? "#1e293b" : "transparent",
                  border: `1px solid ${displayHH?.key === hh.key ? "#334155" : "transparent"}`,
                }}
              >
                <div style={{ color: displayHH?.key === hh.key ? "#60a5fa" : "#64748b", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>
                  House {hh.houseNo || "?"}
                </div>
                <div style={{ color: "#334155", fontSize: 11, marginTop: 2 }}>
                  {hh.members.length} members · {hh.links.length} link{hh.links.length !== 1 ? "s" : ""}
                </div>
              </div>
            ))}
          </>
        )}

        {unlinked.length > 0 && (
          <>
            <div style={{ color: "#1e293b", fontSize: 9, letterSpacing: 1, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 6, marginTop: 12 }}>
              No Links Detected
            </div>
            {unlinked.map(hh => (
              <div
                key={hh.key}
                onClick={() => setSelectedHH(hh)}
                style={{
                  padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 4, opacity: 0.6,
                  background: displayHH?.key === hh.key ? "#1e293b" : "transparent",
                  border: `1px solid ${displayHH?.key === hh.key ? "#334155" : "transparent"}`,
                }}
              >
                <div style={{ color: displayHH?.key === hh.key ? "#60a5fa" : "#475569", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>
                  House {hh.houseNo || "?"}
                </div>
                <div style={{ color: "#334155", fontSize: 11, marginTop: 2 }}>{hh.members.length} members</div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Tree panel */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {displayHH ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div>
                <div style={{ color: "#3b82f6", fontFamily: "monospace", fontWeight: 800, fontSize: 16 }}>
                  House {displayHH.houseNo || "?"}
                </div>
                <div style={{ color: "#475569", fontSize: 12, marginTop: 2 }}>
                  Head: {displayHH.head?.name} · {displayHH.members.length} members · {displayHH.links.length} family connections
                </div>
              </div>
              <button
                onClick={() => setModalHH(displayHH)}
                style={{ marginLeft: "auto", background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "7px 16px", color: "#94a3b8", fontSize: 12, cursor: "pointer", fontFamily: "monospace" }}
              >
                ⤢ Expand
              </button>
            </div>
            <FamilyTreeView household={displayHH} />
          </>
        ) : (
          <div style={{ textAlign: "center", color: "#334155", padding: 60, fontFamily: "monospace" }}>
            Select a household to view its family tree.
          </div>
        )}
      </div>

      {/* Modal */}
      {modalHH && <FamilyTreeModal household={modalHH} onClose={() => setModalHH(null)} />}
    </div>
  );
}

// ─── SAMPLE DATA ──────────────────────────────────────────────────────────────

function buildSampleWorkbook() {
  const wb = XLSX.utils.book_new();
  const booths = {
    "Booth 102": [
      { "Serial No": 1, "Voter Name": "RAJ KUMAR", "Relation Name": "MOHAN KUMAR", "Relation Type": "S/O", "Age": 52, "Gender": "M", "House No": "15A", "EPIC": "TNX1234567" },
      { "Serial No": 2, "Voter Name": "SUNITA DEVI", "Relation Name": "RAJ KUMAR", "Relation Type": "W/O", "Age": 48, "Gender": "F", "House No": "15A", "EPIC": "TNX1234568" },
      { "Serial No": 3, "Voter Name": "ROHIT RAJ", "Relation Name": "RAJ KUMAR", "Relation Type": "S/O", "Age": 24, "Gender": "M", "House No": "15A", "EPIC": "TNX1234569" },
      { "Serial No": 4, "Voter Name": "PRIYA RAJ", "Relation Name": "RAJ KUMAR", "Relation Type": "D/O", "Age": 21, "Gender": "F", "House No": "15A", "EPIC": "TNX1234570" },
      { "Serial No": 5, "Voter Name": "MOHAN KUMAR", "Relation Name": "RATAN LAL", "Relation Type": "S/O", "Age": 78, "Gender": "M", "House No": "15A", "EPIC": "TNX1234571" },
      { "Serial No": 6, "Voter Name": "AMIT SHARMA", "Relation Name": "VIJAY SHARMA", "Relation Type": "S/O", "Age": 35, "Gender": "M", "House No": "22B", "EPIC": "TNX2234567" },
      { "Serial No": 7, "Voter Name": "MEENA SHARMA", "Relation Name": "AMIT SHARMA", "Relation Type": "W/O", "Age": 31, "Gender": "F", "House No": "22B", "EPIC": "TNX2234568" },
      { "Serial No": 8, "Voter Name": "GEETA BAI", "Relation Name": "VIJAY SHARMA", "Relation Type": "W/O", "Age": 62, "Gender": "F", "House No": "22B", "EPIC": "TNX2234569" },
      { "Serial No": 9, "Voter Name": "VIJAY SHARMA", "Relation Name": "RAM SHARMA", "Relation Type": "S/O", "Age": 66, "Gender": "M", "House No": "22B", "EPIC": "TNX2234570" },
    ],
    "Booth 103": [
      { "Serial No": 1, "Voter Name": "SURESH VERMA", "Relation Name": "RAMESH VERMA", "Relation Type": "S/O", "Age": 50, "Gender": "M", "House No": "8C", "EPIC": "TNA3345679" },
      { "Serial No": 2, "Voter Name": "RENU VERMA", "Relation Name": "SURESH VERMA", "Relation Type": "W/O", "Age": 44, "Gender": "F", "House No": "8C", "EPIC": "TNA3345678" },
      { "Serial No": 3, "Voter Name": "ANKIT VERMA", "Relation Name": "SURESH VERMA", "Relation Type": "S/O", "Age": 22, "Gender": "M", "House No": "8C", "EPIC": "TNA3345680" },
      { "Serial No": 4, "Voter Name": "DEEPAK SINGH", "Relation Name": "HAR SINGH", "Relation Type": "S/O", "Age": 55, "Gender": "M", "House No": "12D", "EPIC": "TNA4456790" },
      { "Serial No": 5, "Voter Name": "KAVYA SINGH", "Relation Name": "DEEPAK SINGH", "Relation Type": "D/O", "Age": 26, "Gender": "F", "House No": "12D", "EPIC": "TNA4456789" },
      { "Serial No": 6, "Voter Name": "ASHA SINGH", "Relation Name": "DEEPAK SINGH", "Relation Type": "W/O", "Age": 50, "Gender": "F", "House No": "12D", "EPIC": "TNA4456791" },
    ],
  };
  Object.entries(booths).forEach(([name, rows]) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  });
  return wb;
}

// ─── ICONS ────────────────────────────────────────────────────────────────────

const I = {
  Upload: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>,
  Search: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>,
  House: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>,
  Print: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>,
  Warn: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>,
  ChevD: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>,
  ChevR: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>,
  Spin:  (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite", ...(p.style || {}) }}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>,
  Tree:  (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="2" /><circle cx="6" cy="17" r="2" /><circle cx="18" cy="17" r="2" /><line x1="12" y1="7" x2="12" y2="13" /><line x1="12" y1="13" x2="6" y2="15" /><line x1="12" y1="13" x2="18" y2="15" /></svg>,
};

// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────

function Bar({ value, color = "#3b82f6", h = 5 }) {
  return (
    <div style={{ background: "#1e293b", borderRadius: 99, height: h, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(100, value || 0)}%`, height: "100%", background: color, borderRadius: 99, transition: "width .4s ease" }} />
    </div>
  );
}

function Badge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG["Not Visited"];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: c.bg, color: c.color, border: `1px solid ${c.color}40`, borderRadius: 99, padding: "2px 9px", fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, display: "inline-block" }} />
      {status}
    </span>
  );
}

function FlagBadge() {
  return (
    <span style={{ background: "#4c0519", color: "#f43f5e", padding: "2px 8px", borderRadius: "8px", fontSize: "10px", fontFamily: "monospace", marginLeft: "8px", border: "1px solid #f43f5e55" }}>
      ⚠ FLAG
    </span>
  );
}

function Tile({ label, value, sub, color = "#60a5fa" }) {
  return (
    <div style={{ background: "#0f172a", border: `1px solid ${color}25`, borderRadius: 10, padding: "16px 18px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: -10, right: -10, width: 55, height: 55, borderRadius: "50%", background: `${color}15` }} />
      <div style={{ color: "#64748b", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", fontFamily: "monospace" }}>{label}</div>
      <div style={{ color, fontSize: 28, fontWeight: 800, fontFamily: "monospace", lineHeight: 1.2, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ color: "#475569", fontSize: 11, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─── PRINT ────────────────────────────────────────────────────────────────────

function triggerPrint(boothId, households, stat) {
  const hhRows = households.map(hh => {
    const visited = hh.members.filter(m => m.visitStatus === "Visited").length;
    const followup = hh.members.filter(m => m.visitStatus === "Follow-up").length;
    const mRows = hh.members.map(m =>
      `<tr>
        <td>${m.serial}</td><td><b>${m.name}</b></td>
        <td>${m.relationType} ${m.relationName}</td>
        <td style="text-align:center">${m.age}</td>
        <td style="text-align:center">${m.gender}</td>
        <td style="font-size:11px;color:#555">${m.epic || "—"}</td>
        <td style="text-align:center;color:${m.visitStatus === "Visited" ? "#16a34a" : m.visitStatus === "Follow-up" ? "#d97706" : m.visitStatus === "Unreachable" ? "#dc2626" : "#888"}">${m.visitStatus}</td>
        <td style="font-style:italic;font-size:11px;color:#666">${m.notes || ""}</td>
      </tr>`).join("");
    return `
      <div style="margin-bottom:22px;page-break-inside:avoid">
        <div style="background:#f1f5f9;padding:7px 12px;border-left:4px solid #2563eb;font-size:13px">
          <b>House ${hh.houseNo || "?"}</b>
          <span style="margin-left:14px;color:#555">Head: ${hh.head?.name || "?"}</span>
          <span style="margin-left:14px;color:#555">${hh.members.length} members</span>
          <span style="margin-left:14px;color:#16a34a">Visited: ${visited}</span>
          ${followup ? `<span style="margin-left:12px;color:#d97706">Follow-up: ${followup}</span>` : ""}
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #ddd;font-size:12px">
          <thead><tr style="background:#e2e8f0">
            <th style="padding:5px 8px;text-align:left">S.No</th>
            <th style="padding:5px 8px;text-align:left">Name</th>
            <th style="padding:5px 8px;text-align:left">Relation</th>
            <th style="padding:5px 8px;text-align:center">Age</th>
            <th style="padding:5px 8px;text-align:center">M/F</th>
            <th style="padding:5px 8px;text-align:left">EPIC</th>
            <th style="padding:5px 8px;text-align:center">Status</th>
            <th style="padding:5px 8px;text-align:left">Notes</th>
          </tr></thead>
          <tbody>${mRows}</tbody>
        </table>
      </div>`;
  }).join("");

  const w = window.open("", "_blank");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${boothId} Report</title>
    <style>body{font-family:Arial,sans-serif;color:#111;padding:24px;margin:0}
    table tr:nth-child(even) td{background:#fafafa} td{border-bottom:1px solid #eee;padding:5px 8px}
    @media print{body{padding:0}}</style></head><body>
    <div style="border-bottom:2px solid #1d4ed8;padding-bottom:12px;margin-bottom:20px">
      <h2 style="margin:0;color:#1e3a8a">${boothId} — Field Outreach Report</h2>
      <div style="color:#555;font-size:13px;margin-top:6px">
        Generated: ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} &nbsp;|&nbsp;
        Voters: ${stat?.total || 0} &nbsp;|&nbsp; Households: ${stat?.households || 0} &nbsp;|&nbsp;
        Visited: ${stat?.visited || 0} (${stat?.pct || 0}%) &nbsp;|&nbsp; Follow-up: ${stat?.followup || 0}
      </div>
    </div>
    ${hhRows}
    <div style="margin-top:32px;color:#aaa;font-size:11px;text-align:center;border-top:1px solid #eee;padding-top:12px">
      BoothIntel · Household Intelligence System · Confidential Field Document
    </div></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
}

// ─── VOTER ROW ────────────────────────────────────────────────────────────────

function getRelationTag(v) {
  if (!v.relationType) return "";

  // Wife → W/O
  if (v.relationType === "H/O" || v.relationType === "HUSBAND") {
    if (v.gender === "F") return "W/O";
  }

  // Husband → H/O (rare but keep)
  if (v.relationType === "W/O" && v.gender === "M") {
    return "H/O";
  }

  // Father or Mother → S/O or D/O depending on gender
  if (v.relationType === "F/O" || v.relationType === "Father" || v.relationType === "Mother") {
    return v.gender === "F" ? "D/O" : "S/O";
  }

  // Normal S/O or D/O
  if (v.relationType === "S/O" || v.relationType === "D/O" || v.relationType === "W/O")
    return v.relationType;

  return "";
}

function VoterRow({ voter, onStatus, onNote, isLinked }) {
  const [editNote, setEditNote] = useState(false);
  const [note, setNote] = useState(voter.notes);
  const c = STATUS_CONFIG[voter.visitStatus] || STATUS_CONFIG["Not Visited"];

  // NEW — Correct relation tag
  const relationTag = getRelationTag(voter);
  const rc = RELATION_COLORS[relationTag] || "#94a3b8";

  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
      padding: "10px 12px",
      background: "#0c1629",
      borderRadius: 8,
      borderLeft: `3px solid ${isLinked ? rc : "transparent"}`
    }}>
      {/* GENDER ICON */}
      <div style={{
        width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
        background: voter.gender === "F" ? "#4a044e" : "#0c2a4a",
        border: `2px solid ${voter.gender === "F" ? "#a855f7" : "#3b82f6"}40`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 11, fontWeight: 700,
        color: voter.gender === "F" ? "#d8b4fe" : "#93c5fd"
      }}>
        {voter.gender === "F" ? "F" : "M"}
      </div>

      {/* DETAILS */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          
          {/* NAME */}
          <span style={{
            color: "#f1f5f9",
            fontWeight: 700,
            fontSize: 13,
            fontFamily: "monospace"
          }}>
            {voter.name}
          </span>

          {/* UPDATED RELATION TAG */}
          {relationTag && (
            <span style={{
              color: rc,
              fontSize: 11,
              fontFamily: "monospace",
              background: "#1e293b",
              padding: "1px 6px",
              borderRadius: 4
            }}>
              {relationTag} {voter.relationName}
            </span>
          )}

          {/* AGE */}
          <span style={{ color: "#475569", fontSize: 11 }}>· {voter.age}y</span>

          {/* EPIC */}
          {voter.epic && (
            <span style={{
              color: "#2d3f55",
              fontSize: 10,
              fontFamily: "monospace"
            }}>
              {voter.epic}
            </span>
          )}
        </div>

        {/* NOTES */}
        {voter.notes && !editNote && (
          <div style={{
            color: "#fbbf24",
            fontSize: 11,
            marginTop: 4,
            fontStyle: "italic"
          }}>
            📝 {voter.notes}
          </div>
        )}

        {/* EDIT NOTE */}
        {editNote && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add field note..."
              style={{
                flex: 1, background: "#1e293b",
                border: "1px solid #334155",
                borderRadius: 6,
                padding: "5px 9px",
                color: "#f1f5f9",
                fontSize: 12,
                outline: "none"
              }}
            />
            <button
              onClick={() => { onNote(voter.id, note); setEditNote(false); }}
              style={{
                background: "#10b981",
                border: "none",
                borderRadius: 6,
                padding: "5px 12px",
                color: "#fff",
                fontSize: 12,
                cursor: "pointer"
              }}
            >
              ✓
            </button>
            <button
              onClick={() => setEditNote(false)}
              style={{
                background: "#1e293b",
                border: "1px solid #334155",
                borderRadius: 6,
                padding: "5px 10px",
                color: "#64748b",
                fontSize: 12,
                cursor: "pointer"
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* STATUS DROPDOWN */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
        <button
          onClick={() => setEditNote(!editNote)}
          style={{
            background: "none",
            border: "1px solid #1e293b",
            borderRadius: 6,
            padding: "4px 7px",
            color: "#475569",
            fontSize: 12,
            cursor: "pointer"
          }}
        >
          📝
        </button>

        <select
          value={voter.visitStatus}
          onChange={e => onStatus(voter.id, e.target.value)}
          style={{
            background: c.bg,
            border: `1px solid ${c.color}40`,
            borderRadius: 6,
            padding: "4px 8px",
            color: c.color,
            fontSize: 11,
            cursor: "pointer",
            outline: "none",
            fontFamily: "monospace"
          }}
        >
          {Object.keys(STATUS_CONFIG).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─── HOUSEHOLD CARD ───────────────────────────────────────────────────────────

function HHCard({ hh, onStatus, onNote, onTreeClick }) {
  const [open, setOpen] = useState(false);
  const visited = hh.members.filter(m => m.visitStatus === "Visited").length;
  const pct = Math.round((visited / hh.members.length) * 100);
  const dominant = visited === hh.members.length ? "Visited"
    : hh.members.some(m => m.visitStatus === "Follow-up") ? "Follow-up"
    : hh.members.some(m => m.visitStatus === "Unreachable") ? "Unreachable"
    : "Not Visited";
  const linkedIds = new Set(hh.links.flatMap(l => [l.from, l.to]));

  return (
    <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" }}>
      <div onClick={() => setOpen(!open)} style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", cursor: "pointer", userSelect: "none" }}>
        <I.House width={16} height={16} style={{ color: "#3b82f6", flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace", fontSize: 14 }}>
              House {hh.houseNo || "—"}
            </span>
            <Badge status={dominant} />
            {hh.sus_flag && <FlagBadge />}
            <span style={{ color: "#475569", fontSize: 12 }}>{hh.members.length} voter{hh.members.length !== 1 ? "s" : ""} · Head: {hh.head?.name}</span>
          </div>
          <div style={{ marginTop: 7 }}>
            <Bar value={pct} color={pct === 100 ? "#10b981" : pct > 50 ? "#fbbf24" : "#3b82f6"} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Family tree button */}
          {hh.links.length > 0 && (
            <button
              onClick={e => { e.stopPropagation(); onTreeClick(hh); }}
              title="View Family Tree"
              style={{ background: "#0c2a4a", border: "1px solid #1e3a5f", borderRadius: 6, padding: "4px 8px", color: "#60a5fa", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
            >
              <I.Tree width={12} height={12} /> Tree
            </button>
          )}
          <span style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>{pct}%</span>
          {open ? <I.ChevD width={14} height={14} style={{ color: "#64748b" }} /> : <I.ChevR width={14} height={14} style={{ color: "#64748b" }} />}
        </div>
      </div>
      {open && (
        <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
          {hh.links.length > 0 && (
            <div style={{ padding: "7px 10px", background: "#111827", borderRadius: 7, marginBottom: 4, display: "flex", flexWrap: "wrap", gap: 8 }}>
              <span style={{ color: "#475569", fontSize: 11 }}>Family links:</span>
              {hh.links.map((l, i) => {
                const f = hh.members.find(m => m.id === l.from);
                const t = hh.members.find(m => m.id === l.to);
                if (!f || !t) return null;
                const rc = RELATION_COLORS[l.type] || "#94a3b8";
                return <span key={i} style={{ color: rc, fontSize: 11, fontFamily: "monospace" }}>{f.name} → {t.name} <span style={{ color: "#334155" }}>({l.type})</span></span>;
              })}
            </div>
          )}
          {hh.members.map(v => <VoterRow key={v.id} voter={v} onStatus={onStatus} onNote={onNote} isLinked={linkedIds.has(v.id)} />)}
        </div>
      )}
    </div>
  );
}

// ─── FLASK BACKEND UPLOAD ─────────────────────────────────────────────────────

async function uploadViaPipeline(file, onData, setLoadingMsg) {
  try {
    setLoadingMsg("Uploading to OCR pipeline…");
    const form = new FormData();
    form.append("file", file);

    const res = await fetch(`${BACKEND_URL}/upload-electoral-roll`, { method: "POST", body: form });

    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      onData(null, null, `Server error (${res.status}): ${txt}`);
      return;
    }

    const json = await res.json();
    if (!json.csv) {
      onData(null, null, "Pipeline did not return a CSV. Check your Flask server logs.");
      return;
    }

    setLoadingMsg("Downloading processed CSV…");
    const csvRes = await fetch(`${BACKEND_URL}/get-csv/${json.csv}`);
    if (!csvRes.ok) { onData(null, null, `Could not fetch CSV: ${csvRes.statusText}`); return; }
    const csvText = await csvRes.text();

    setLoadingMsg("Building household map…");
    const boothLabel = file.name.replace(/\.[^/.]+$/, "").replace(/_/g, " ").trim();
    const raw = parsePipelineCSV(csvText, boothLabel);

    if (!raw.length) {
      onData(null, null, "No voters could be parsed from the pipeline CSV.");
      return;
    }

    const voters = dedup(raw);
    const boothNames = [...new Set(voters.map(v => v.booth))].sort();
    onData(voters, boothNames, null);
  } catch (err) {
    if (err.name === "TypeError" && err.message.includes("fetch")) {
      onData(null, null, `Cannot reach Flask backend at ${BACKEND_URL}. Make sure server.py is running:\n  python server.py`);
    } else {
      onData(null, null, `Unexpected error: ${err.message}`);
    }
  }
}

// ─── UPLOAD SCREEN ────────────────────────────────────────────────────────────

function UploadScreen({ onData, error }) {
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");

  const processExcel = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const sheets = wb.SheetNames;
        if (!sheets.length) { onData(null, null, "The uploaded file has no sheets."); return; }

        if (sheets.length === 1) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheets[0]]);
          if (!rows.length) { onData(null, null, "The uploaded file is empty."); return; }
          const boothName = file.name.replace(/\.[^/.]+$/, "").replace(/_/g, " ").trim();
          onData(dedup(parseSheetRows(rows, boothName)), [boothName], null);
          return;
        }

        const allVoters = [], boothNames = [];
        for (const name of sheets) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[name]);
          if (!rows.length) continue;
          allVoters.push(...parseSheetRows(rows, name));
          boothNames.push(name);
        }
        if (!allVoters.length) { onData(null, null, "No voter data could be read."); return; }
        onData(dedup(allVoters), boothNames, null);
      } catch {
        onData(null, null, "Could not read file. Make sure it is a valid .xlsx or .xls file.");
      }
    };
    reader.readAsArrayBuffer(file);
  }, [onData]);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (["pdf", "aspx"].includes(ext)) {
      setLoading(true);
      setLoadingMsg("Connecting to OCR server…");
      await uploadViaPipeline(file, (voters, booths, err) => {
        setLoading(false); setLoadingMsg("");
        onData(voters, booths, err);
      }, setLoadingMsg);
    } else if (["xlsx", "xls", "csv"].includes(ext)) {
      processExcel(file);
    } else {
      onData(null, null, `Unsupported file type ".${ext}". Use .xlsx, .xls, .pdf, or .aspx`);
    }
  }, [onData, processExcel]);

  const loadSample = () => {
    const wb = buildSampleWorkbook();
    const allVoters = [], boothNames = [];
    for (const name of wb.SheetNames) {
      allVoters.push(...parseSheetRows(XLSX.utils.sheet_to_json(wb.Sheets[name]), name));
      boothNames.push(name);
    }
    onData(dedup(allVoters), boothNames, null);
  };

  return (
    <div style={{ maxWidth: 620, margin: "60px auto", padding: "0 24px" }}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <div style={{ fontSize: 52, marginBottom: 12 }}>🗳️</div>
        <div style={{ color: "#f1f5f9", fontFamily: "monospace", fontSize: 26, fontWeight: 800 }}>BoothIntel</div>
        <div style={{ color: "#64748b", marginTop: 8, fontSize: 13 }}>Booth-level household intelligence & outreach tracking</div>
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
        style={{ border: `2px dashed ${drag ? "#3b82f6" : "#1e293b"}`, borderRadius: 14, padding: "44px 32px", textAlign: "center", background: drag ? "#1e3a5f18" : "#0f172a", transition: "all .2s" }}
      >
        {loading ? (
          <div>
            <I.Spin width={36} height={36} style={{ color: "#3b82f6", margin: "0 auto 16px", display: "block" }} />
            <div style={{ color: "#f1f5f9", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{loadingMsg}</div>
            <div style={{ color: "#475569", fontSize: 12 }}>This may take a minute for large PDFs…</div>
          </div>
        ) : (
          <>
            <I.Upload width={34} height={34} style={{ color: "#3b82f6", margin: "0 auto 14px", display: "block" }} />
            <div style={{ color: "#f1f5f9", fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Drop your Electoral Roll here</div>
            <div style={{ color: "#475569", fontSize: 13, marginBottom: 24, lineHeight: 1.8 }}>
              <span style={{ color: "#64748b", fontWeight: 600 }}>Excel (.xlsx/.xls)</span> — processed in browser<br />
              <span style={{ color: "#64748b", fontWeight: 600 }}>PDF / ASPX</span> — sent to Flask OCR pipeline at <code style={{ color: "#94a3b8", fontSize: 12 }}>{BACKEND_URL}</code>
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <label style={{ background: "#1d4ed8", color: "#fff", borderRadius: 8, padding: "10px 22px", fontSize: 14, cursor: "pointer", fontFamily: "monospace", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 8 }}>
                <I.Upload width={16} height={16} /> Choose File
                <input type="file" accept=".xlsx,.xls,.pdf,.aspx,.csv" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); }} />
              </label>
              <button onClick={loadSample} style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "10px 22px", color: "#94a3b8", fontSize: 14, cursor: "pointer", fontFamily: "monospace" }}>
                Load Sample
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 16, background: "#450a0a", border: "1px solid #dc262640", borderRadius: 10, padding: "14px 18px", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <I.Warn width={18} height={18} style={{ color: "#f87171", flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ color: "#f87171", fontWeight: 700, fontSize: 13, fontFamily: "monospace", marginBottom: 4 }}>Error</div>
            <pre style={{ color: "#fca5a5", fontSize: 12, lineHeight: 1.6, margin: 0, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{error}</pre>
          </div>
        </div>
      )}

      <div style={{ marginTop: 18, background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ color: "#475569", fontSize: 12, fontFamily: "monospace", lineHeight: 1.9 }}>
          <div><span style={{ color: "#64748b" }}>Excel columns:</span> Voter Name · Relation Name · Relation Type · Age · Gender · House No · EPIC</div>
          <div><span style={{ color: "#64748b" }}>Pipeline CSV:</span> voter_id · name · relation_type · relation_name · house_number · age · gender · part_no</div>
          <div style={{ marginTop: 6, color: "#334155" }}>✦ New: Family tree visualization — auto-detects relations within households.</div>
        </div>
      </div>
    </div>
  );
}
function detectSuspicious(hh) {
  const reasons = [];
  let score = 0;

  const members = hh.members;
  const ages = members.map(m => m.age).filter(Boolean);
  const rels = members.map(m => m.relationType);
  const names = members.map(m => m.name);

  // ───────────────────────────────────────────────
  // RULE 1: Impossible father–child ages
  // ───────────────────────────────────────────────
  members.forEach(m => {
    if (m.relationType === "S/O" || m.relationType === "D/O") {
      const parent = members.find(p => similarity(p.name, m.relationName) >= 0.6);
      if (parent && parent.age - m.age < 15) {
        reasons.push(`Parent-child impossible age gap (${parent.age} & ${m.age})`);
        score += 2;
      }
    }
  });

  // ───────────────────────────────────────────────
  // RULE 2: Too many "heads" (multiple S/O or W/O or H/O)
  // ───────────────────────────────────────────────
  const headCount = members.filter(m =>
    ["S/O", "W/O", "H/O", "F/O"].includes(m.relationType)
  ).length;

  if (headCount > 4) {
    reasons.push(`Unusually many household heads (${headCount})`);
    score += 2;
  }

  // ───────────────────────────────────────────────
  // RULE 3: Age anomalies
  // ───────────────────────────────────────────────
  if (ages.some(a => a < 18)) {
    reasons.push("Voter list shows under-18 age (invalid)");
    score += 2;
  }

  if (ages.length > 4) {
    const oldest = Math.max(...ages);
    const youngest = Math.min(...ages);
    if (oldest - youngest < 10) {
      reasons.push("Implausible age distribution");
      score += 2;
    }
  }

  // ───────────────────────────────────────────────
  // RULE 4: Duplicate names with same relation type
  // ───────────────────────────────────────────────
  const dup = {};
  members.forEach(m => {
    const key = `${m.name}_${m.relationType}`;
    dup[key] = (dup[key] || 0) + 1;
  });

  Object.entries(dup).forEach(([k, count]) => {
    if (count >= 2) {
      reasons.push(`Duplicate identity: ${k.replace("_", " ")} (${count} entries)`);
      score += 2;
    }
  });

  // ───────────────────────────────────────────────
  // RULE 5: Large household without relations
  // ───────────────────────────────────────────────
  if (members.length > 8 && hh.links.length === 0) {
    reasons.push("Large household with no family links detected");
    score += 2;
  }

  return {
    sus_flag: reasons.length > 0,
    sus_score: score,
    sus_reasons: reasons
  };
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function Dashboard({ boothStats, onSelect }) {
  const total = boothStats.reduce((s, b) => s + b.total, 0);
  const totalHH = boothStats.reduce((s, b) => s + b.households, 0);
  const vis = boothStats.reduce((s, b) => s + b.visited, 0);
  const fu = boothStats.reduce((s, b) => s + b.followup, 0);
  const nv = boothStats.reduce((s, b) => s + b.notVisited, 0);
  const pct = total ? Math.round(vis / total * 100) : 0;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 26 }}>
        <Tile label="Total Voters" value={total} color="#60a5fa" />
        <Tile label="Households" value={totalHH} color="#a78bfa" />
        <Tile label="Booths" value={boothStats.length} color="#34d399" />
        <Tile label="Coverage" value={`${pct}%`} sub={`${vis} visited`} color="#10b981" />
        <Tile label="Follow-up" value={fu} color="#fbbf24" />
        <Tile label="Not Visited" value={nv} color="#64748b" />
      </div>

      <div style={{ color: "#334155", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 12 }}>── Booth-wise Breakdown</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {boothStats.map(s => (
          <div key={s.booth} onClick={() => onSelect(s.booth)}
            style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "14px 18px", cursor: "pointer", display: "flex", gap: 16, alignItems: "center" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "#3b82f640"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "#1e293b"}>
            <div style={{ fontFamily: "monospace", fontWeight: 800, color: "#3b82f6", fontSize: 15, minWidth: 120 }}>{s.booth}</div>
            <div style={{ display: "flex", gap: 18, fontSize: 12, color: "#64748b" }}>
              <span><span style={{ color: "#94a3b8", fontFamily: "monospace" }}>{s.total}</span> voters</span>
              <span><span style={{ color: "#94a3b8", fontFamily: "monospace" }}>{s.households}</span> houses</span>
              <span><span style={{ color: "#34d399", fontFamily: "monospace" }}>{s.visited}</span> visited</span>
              {s.followup > 0 && <span><span style={{ color: "#fbbf24", fontFamily: "monospace" }}>{s.followup}</span> follow-up</span>}
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ width: 130 }}><Bar value={s.pct} color={s.pct === 100 ? "#10b981" : s.pct > 50 ? "#fbbf24" : "#3b82f6"} h={6} /></div>
            <div style={{ color: "#64748b", fontSize: 13, fontFamily: "monospace", width: 36, textAlign: "right" }}>{s.pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── BOOTH VIEW ───────────────────────────────────────────────────────────────

function BoothView({ boothId, households, stat, onStatus, onNote }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [treeHH, setTreeHH] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return households.filter(hh => {
      const ms = !q || hh.houseNo.includes(q) || hh.members.some(m => m.name.includes(q) || m.epic.includes(q) || m.relationName.includes(q));
      const mf = filter === "All" || hh.members.some(m => m.visitStatus === filter);
      return ms && mf;
    });
  }, [households, search, filter]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ color: "#3b82f6", fontFamily: "monospace", fontSize: 22, fontWeight: 800 }}>{boothId}</div>
          <div style={{ color: "#475569", fontSize: 13, marginTop: 2 }}>{stat?.total} voters · {stat?.households} households · {stat?.pct}% visited</div>
        </div>
        <button onClick={() => triggerPrint(boothId, households, stat)}
          style={{ display: "flex", alignItems: "center", gap: 8, background: "#1e3a5f", border: "1px solid #2563eb40", borderRadius: 8, padding: "9px 18px", color: "#60a5fa", fontSize: 13, cursor: "pointer", fontFamily: "monospace", fontWeight: 600 }}>
          <I.Print width={15} height={15} /> Print / PDF Report
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 18 }}>
        <Tile label="Total" value={stat?.total || 0} color="#60a5fa" />
        <Tile label="Visited" value={stat?.visited || 0} sub={`${stat?.pct || 0}% done`} color="#10b981" />
        <Tile label="Follow-up" value={stat?.followup || 0} color="#fbbf24" />
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <I.Search width={14} height={14} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#475569" }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, house, EPIC…"
            style={{ width: "100%", background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, padding: "9px 12px 9px 34px", color: "#f1f5f9", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
        </div>
        <select value={filter} onChange={e => setFilter(e.target.value)}
          style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, padding: "9px 14px", color: "#94a3b8", fontSize: 13, outline: "none" }}>
          <option value="All">All Status</option>
          {Object.keys(STATUS_CONFIG).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "#334155", padding: 48, fontFamily: "monospace" }}>No households match.</div>}
        {filtered.map(hh => (
          <HHCard key={hh.key} hh={hh} onStatus={onStatus} onNote={onNote} onTreeClick={setTreeHH} />
        ))}
      </div>

      {treeHH && <FamilyTreeModal household={treeHH} onClose={() => setTreeHH(null)} />}
    </div>
  );
}

// ─── GLOBAL SEARCH ────────────────────────────────────────────────────────────

function GlobalSearch({ voters, onStatus }) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const s = q.trim().toUpperCase();
    if (!s) return [];
    return voters.filter(v =>
      v.name.includes(s) || v.epic.includes(s) ||
      v.houseNo.includes(s) || v.booth.toUpperCase().includes(s)
    ).slice(0, 60);
  }, [q, voters]);

  return (
    <div>
      <div style={{ color: "#334155", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 14 }}>── Global Voter Search</div>
      <div style={{ position: "relative", marginBottom: 18 }}>
        <I.Search width={16} height={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "#475569" }} />
        <input value={q} onChange={e => setQ(e.target.value)} autoFocus placeholder="Search by voter name, EPIC, house number, or booth…"
          style={{ width: "100%", background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 16px 12px 44px", color: "#f1f5f9", fontSize: 15, outline: "none", boxSizing: "border-box" }} />
      </div>
      {q && !results.length && <div style={{ textAlign: "center", color: "#334155", padding: 48, fontFamily: "monospace" }}>No results for "{q}"</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {results.map(v => {
          const c = STATUS_CONFIG[v.visitStatus] || STATUS_CONFIG["Not Visited"];
          return (
            <div key={v.id} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 16px", display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0, background: v.gender === "F" ? "#4a044e" : "#0c2a4a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: v.gender === "F" ? "#d8b4fe" : "#93c5fd" }}>
                {v.gender === "F" ? "F" : "M"}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ color: "#f1f5f9", fontWeight: 700, fontFamily: "monospace", fontSize: 14 }}>{v.name}</span>
                  <span style={{ color: "#475569", fontSize: 12 }}>{v.booth} · House {v.houseNo}</span>
                </div>
                <div style={{ color: "#475569", fontSize: 12, marginTop: 2 }}>{v.relationType} {v.relationName} · Age {v.age} · {v.epic || "No EPIC"}</div>
              </div>
              <select value={v.visitStatus} onChange={e => onStatus(v.id, e.target.value)}
                style={{ background: c.bg, border: `1px solid ${c.color}40`, borderRadius: 6, padding: "5px 10px", color: c.color, fontSize: 11, cursor: "pointer", outline: "none", fontFamily: "monospace" }}>
                {Object.keys(STATUS_CONFIG).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [voters, setVoters] = useState([]);
  const [boothNames, setBoothNames] = useState([]);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [activeBooth, setActiveBooth] = useState(null);

  const onData = useCallback((v, b, err) => {
    if (err) { setError(err); return; }
    setVoters(v);
    setBoothNames(b);
    setActiveBooth(b[0] || null);
    setLoaded(true);
    setTab("dashboard");
    setError(null);
  }, []);

  const onStatus = useCallback((id, status) => {
    setVoters(prev => prev.map(v =>
      v.id === id ? { ...v, visitStatus: status, lastVisitDate: new Date().toISOString().slice(0, 10) } : v
    ));
  }, []);

  const onNote = useCallback((id, note) => {
    setVoters(prev => prev.map(v => v.id === id ? { ...v, notes: note } : v));
  }, []);

  const households = useMemo(() => buildHouseholds(voters), [voters]);

  const boothHouseholds = useMemo(() => {
    const map = {};
    for (const hh of households) {
      if (!map[hh.booth]) map[hh.booth] = [];
      map[hh.booth].push(hh);
    }
    return map;
  }, [households]);

  const boothStats = useMemo(() => boothNames.map(b => {
    const hhs = boothHouseholds[b] || [];
    const vs = hhs.flatMap(h => h.members);
    const visited = vs.filter(v => v.visitStatus === "Visited").length;
    const followup = vs.filter(v => v.visitStatus === "Follow-up").length;
    const notVisited = vs.filter(v => v.visitStatus === "Not Visited").length;
    return { booth: b, households: hhs.length, total: vs.length, visited, followup, notVisited, pct: vs.length ? Math.round(visited / vs.length * 100) : 0 };
  }), [boothNames, boothHouseholds, voters]);

  const totalVoters = voters.length;
  const overallPct = totalVoters ? Math.round(voters.filter(v => v.visitStatus === "Visited").length / totalVoters * 100) : 0;

  if (!loaded) {
    return (
      <div style={{ minHeight: "100vh", background: "#060d1a", color: "#f1f5f9" }}>
        <UploadScreen onData={onData} error={error} />
        <style>{`*{box-sizing:border-box}body{margin:0}select option{background:#1e293b}input::placeholder{color:#334155}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#060d1a", color: "#f1f5f9", fontFamily: "Georgia,serif" }}>
      {/* Header */}
      <div style={{ background: "#0a1628", borderBottom: "1px solid #1e293b", padding: "0 24px", height: 56, display: "flex", alignItems: "center", gap: 16, position: "sticky", top: 0, zIndex: 100 }}>
        <span style={{ fontSize: 20 }}>🗳️</span>
        <span style={{ color: "#3b82f6", fontFamily: "monospace", fontWeight: 800, fontSize: 16 }}>BoothIntel</span>
        <span style={{ color: "#1e293b" }}>|</span>
        <span style={{ color: "#334155", fontSize: 12, fontFamily: "monospace" }}>{boothNames.length} booths · {totalVoters} voters · {overallPct}% covered</span>
        <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
          {[
            ["dashboard", "📊 Dashboard"],
            ["booths",    "🏛️ Booths"],
            ["family",    "🌳 Family Trees"],
            ["search",    "🔍 Search"],
          ].map(([id, lbl]) => (
            <button key={id} onClick={() => setTab(id)}
              style={{ background: tab === id ? "#1e293b" : "transparent", border: `1px solid ${tab === id ? "#334155" : "transparent"}`, borderRadius: 7, padding: "5px 13px", color: tab === id ? "#f1f5f9" : "#64748b", fontSize: 13, cursor: "pointer", fontFamily: "monospace" }}>
              {lbl}
            </button>
          ))}
          <button onClick={() => { setLoaded(false); setVoters([]); setBoothNames([]); setError(null); }}
            style={{ background: "none", border: "1px solid #1e293b", borderRadius: 7, padding: "5px 10px", color: "#475569", fontSize: 12, cursor: "pointer", marginLeft: 8 }}>
            ↩ Reset
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 24px" }}>
        {tab === "dashboard" && (
          <Dashboard boothStats={boothStats} onSelect={b => { setActiveBooth(b); setTab("booths"); }} />
        )}

        {tab === "booths" && (
          <div style={{ display: "flex", gap: 20 }}>
            <div style={{ width: 180, flexShrink: 0 }}>
              <div style={{ color: "#334155", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontFamily: "monospace", marginBottom: 10 }}>Booths</div>
              {boothStats.map(s => (
                <div key={s.booth} onClick={() => setActiveBooth(s.booth)}
                  style={{ padding: "10px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 4, background: activeBooth === s.booth ? "#1e293b" : "transparent", border: `1px solid ${activeBooth === s.booth ? "#334155" : "transparent"}` }}>
                  <div style={{ color: activeBooth === s.booth ? "#60a5fa" : "#64748b", fontFamily: "monospace", fontWeight: 700, fontSize: 13 }}>{s.booth}</div>
                  <div style={{ color: "#334155", fontSize: 11, marginTop: 2 }}>{s.total} voters</div>
                  <div style={{ marginTop: 5 }}><Bar value={s.pct} color="#3b82f6" h={4} /></div>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {activeBooth
                ? <BoothView boothId={activeBooth} households={boothHouseholds[activeBooth] || []} stat={boothStats.find(s => s.booth === activeBooth)} onStatus={onStatus} onNote={onNote} />
                : <div style={{ textAlign: "center", color: "#334155", padding: 60, fontFamily: "monospace" }}>Select a booth from the sidebar</div>
              }
            </div>
          </div>
        )}

        {tab === "family" && (
          <div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ color: "#f1f5f9", fontFamily: "monospace", fontWeight: 800, fontSize: 20, marginBottom: 4 }}>🌳 Family Trees</div>
              <div style={{ color: "#475569", fontSize: 13 }}>
                Visual household relationship graphs — auto-detected from relation name matching.
              </div>
            </div>

            {/* Booth selector for family trees */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
              {boothNames.map(b => (
                <button
                  key={b}
                  onClick={() => setActiveBooth(b)}
                  style={{
                    background: activeBooth === b ? "#1e293b" : "#0f172a",
                    border: `1px solid ${activeBooth === b ? "#3b82f6" : "#1e293b"}`,
                    borderRadius: 8, padding: "7px 16px", color: activeBooth === b ? "#60a5fa" : "#64748b",
                    fontSize: 13, cursor: "pointer", fontFamily: "monospace", fontWeight: activeBooth === b ? 700 : 400,
                  }}
                >
                  {b}
                </button>
              ))}
            </div>

            {activeBooth && boothHouseholds[activeBooth] ? (
              <BoothFamilyTreePanel households={boothHouseholds[activeBooth]} />
            ) : (
              <div style={{ textAlign: "center", color: "#334155", padding: 60, fontFamily: "monospace" }}>
                Select a booth above to view family trees.
              </div>
            )}
          </div>
        )}

        {tab === "search" && <GlobalSearch voters={voters} onStatus={onStatus} />}
      </div>

      <style>{`*{box-sizing:border-box}body{margin:0}select option{background:#1e293b}input::placeholder{color:#334155}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0a1628}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:3px}@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}