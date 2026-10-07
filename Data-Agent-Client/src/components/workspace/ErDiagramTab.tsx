import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { I18N_KEYS } from '../../constants/i18nKeys';
import { tableService, type ErDiagram, type ErTable } from '../../services/table.service';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { TableDblClickConsoleTargetEnum } from '../../constants/workspacePreferences';
import type { ConsoleTabMetadata, ErDiagramTabMetadata } from '../../types/tab';
import { useToast } from '../../hooks/useToast';
import {
  downloadBlob,
  erDiagramFilename,
  renderErDiagramPng,
  type ErExportScene,
} from './erDiagramExport';
import {
  anchorColumns,
  cardinalityLabel,
  columnKey,
  endMarks,
  filterTablesByName,
  fitDiagramView,
  isCrossRelation,
  junctionTableId,
  relationFromId,
  relationMapping,
  relationToId,
  relationTouches,
  sideColumns,
  tableId,
  viaTableName,
  zoomDiagramView,
  collapseJunctions,
  type ColumnFocus,
  type EndMark,
} from './erDiagramRelations';

const CARD_WIDTH = 260;
const COLUMN_GAP = 72;
const ROW_GAP = 56;
const CARD_EDGE = 8;
const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 22;
const MAX_VISIBLE_ROWS = 12;

interface CardBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  col: number;
  row: number;
}

interface Point {
  x: number;
  y: number;
}

interface Channels {
  rowCount: number;
  vertical: number[];
  horizontal: number[];
}

interface RelationLine {
  key: string;
  d: string;
  cross: boolean;
  manyToMany: boolean;
  fromMark: EndMark;
  toMark: EndMark;
}

function scopeLabel(catalog?: string | null, schema?: string | null) {
  return schema || catalog || '';
}

function tableTitle(table: ErTable) {
  if (!table.external) return table.name;
  const scope = scopeLabel(table.catalog, table.schema);
  return scope ? `${scope}.${table.name}` : table.name;
}

function cardHeight(columnCount: number) {
  const rows = Math.min(Math.max(columnCount, 1), MAX_VISIBLE_ROWS);
  return HEADER_HEIGHT + rows * ROW_HEIGHT + 8;
}

function layoutCards(diagram: ErDiagram): { boxes: CardBox[]; width: number; height: number } {
  const local = diagram.tables.filter((table) => !table.external);
  const external = diagram.tables.filter((table) => table.external);
  const columns = local.length === 0 ? 0 : Math.max(1, Math.ceil(Math.sqrt(local.length)));
  const rowCount = columns === 0 ? 0 : Math.ceil(local.length / columns);
  const rowHeights: number[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    let height = 80;
    for (let column = 0; column < columns; column += 1) {
      const table = local[row * columns + column];
      if (table) height = Math.max(height, cardHeight(table.columns.length));
    }
    rowHeights.push(height);
  }

  const boxes: CardBox[] = [];
  local.forEach((table, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const rowY = rowHeights.slice(0, row).reduce((sum, height) => sum + height + ROW_GAP, 24);
    boxes.push({
      id: tableId(table),
      x: 24 + column * (CARD_WIDTH + COLUMN_GAP),
      y: rowY,
      width: CARD_WIDTH,
      height: cardHeight(table.columns.length),
      col: column,
      row,
    });
  });

  const externalCol = columns;
  let externalY = 24;
  external.forEach((table, index) => {
    const height = cardHeight(table.columns.length);
    boxes.push({
      id: tableId(table),
      x: 24 + externalCol * (CARD_WIDTH + COLUMN_GAP),
      y: externalY,
      width: CARD_WIDTH,
      height,
      col: externalCol,
      row: index,
    });
    externalY += height + ROW_GAP;
  });

  const usedColumns = external.length > 0 ? externalCol + 1 : columns;
  const width = usedColumns === 0
    ? 48
    : 48 + usedColumns * CARD_WIDTH + Math.max(0, usedColumns - 1) * COLUMN_GAP;
  const localHeight = rowCount === 0
    ? 48
    : 48 + rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rowCount - 1) * ROW_GAP;
  const externalHeight = external.length === 0 ? 0 : externalY - ROW_GAP + 24;
  return { boxes, width, height: Math.max(localHeight, externalHeight) };
}

const ROSE = '#e11d48';
const VIOLET = '#7c3aed';

function CardinalityMarker({ id, mark, color }: { id: string; mark: EndMark; color: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 14 14"
      refX="13"
      refY="7"
      markerWidth="13"
      markerHeight="13"
      orient="auto-start-reverse"
      markerUnits="userSpaceOnUse"
    >
      {mark === 'one' ? (
        <path d="M11 1 V13" fill="none" stroke={color} strokeWidth="1.6" />
      ) : (
        <path d="M1 7 L13 1 M1 7 L13 7 M1 7 L13 13" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      )}
    </marker>
  );
}

function LegendSample({ mark, label, color, dashed }: { mark?: EndMark; label: string; color?: string; dashed?: boolean }) {
  const stroke = color ?? 'currentColor';
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="26" height="12" aria-hidden="true">
        {mark === 'many' ? (
          <path d="M1 6 L8 1 M1 6 H25 M1 6 L8 11" fill="none" stroke={stroke} strokeWidth="1.4" strokeDasharray={dashed ? '3 2' : undefined} />
        ) : mark === 'one' ? (
          <path d="M2 1 V11 M6 6 H25" fill="none" stroke={stroke} strokeWidth="1.4" />
        ) : (
          <path d="M1 6 H25" fill="none" stroke={stroke} strokeWidth="1.4" strokeDasharray="3 2" />
        )}
      </svg>
      <span>{label}</span>
    </span>
  );
}

function revealRow(row: HTMLElement, scale: number, skipScroller: HTMLElement | null) {
  const scroller = row.parentElement;
  if (!scroller || scroller === skipScroller || scale <= 0) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const topGap = (scrollerRect.top - rowRect.top) / scale;
  const bottomGap = (rowRect.bottom - scrollerRect.bottom) / scale;
  if (topGap > 1) {
    scroller.scrollTop -= topGap;
  } else if (bottomGap > 1) {
    scroller.scrollTop += bottomGap;
  }
}

function endpoint(canvas: HTMLElement, row: HTMLElement, edge: 'left' | 'right', scale: number) {
  const canvasRect = canvas.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const x = (edge === 'right' ? rowRect.right : rowRect.left) - canvasRect.left;
  const y = rowRect.top + rowRect.height / 2 - canvasRect.top;
  return {
    x: Math.round((x / scale + (edge === 'right' ? 2 : -2)) * 10) / 10,
    y: Math.round((y / scale) * 10) / 10,
  };
}

function buildChannels(boxes: CardBox[]): Channels {
  if (boxes.length === 0) return { rowCount: 0, vertical: [12], horizontal: [12] };
  const columnCount = Math.max(...boxes.map((box) => box.col)) + 1;
  const rowCount = Math.max(...boxes.map((box) => box.row)) + 1;
  const vertical = [12];
  for (let col = 0; col < columnCount - 1; col += 1) {
    const left = boxes.find((box) => box.col === col);
    const right = boxes.find((box) => box.col === col + 1);
    if (left && right) vertical.push((left.x + left.width + right.x) / 2);
  }
  const lastColumn = boxes.find((box) => box.col === columnCount - 1);
  vertical.push(lastColumn ? lastColumn.x + lastColumn.width + 12 : 12);

  const horizontal = [12];
  for (let row = 0; row < rowCount - 1; row += 1) {
    const current = boxes.filter((box) => box.row === row);
    const next = boxes.filter((box) => box.row === row + 1);
    if (current.length === 0 || next.length === 0) {
      horizontal.push(horizontal[horizontal.length - 1] + ROW_GAP);
      continue;
    }
    const bottom = Math.max(...current.map((box) => box.y + box.height));
    const top = Math.min(...next.map((box) => box.y));
    horizontal.push((bottom + top) / 2);
  }
  const lastRow = boxes.filter((box) => box.row === rowCount - 1);
  const lastRowBottom = lastRow.length === 0
    ? horizontal[horizontal.length - 1]
    : Math.max(...lastRow.map((box) => box.y + box.height));
  horizontal.push(lastRowBottom + 12);
  return { rowCount, vertical, horizontal };
}

function appendPoint(points: Point[], x: number, y: number) {
  const rounded = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  const last = points[points.length - 1];
  if (!last) {
    points.push(rounded);
    return;
  }
  if (Math.abs(last.x - rounded.x) < 0.5 && Math.abs(last.y - rounded.y) < 0.5) return;
  if (Math.abs(last.x - rounded.x) >= 0.5 && Math.abs(last.y - rounded.y) >= 0.5) {
    points.push({ x: last.x, y: rounded.y });
  }
  points.push(rounded);
}

function boxesOverlapHorizontally(fromBox: CardBox, toBox: CardBox) {
  return fromBox.x < toBox.x + toBox.width + 8 && toBox.x < fromBox.x + fromBox.width + 8;
}

function routeEdgesFree(fromBox: CardBox, toBox: CardBox): { fromEdge: 'left' | 'right'; toEdge: 'left' | 'right' } {
  const fromCenter = fromBox.x + fromBox.width / 2;
  const toCenter = toBox.x + toBox.width / 2;
  if (fromBox.id === toBox.id || boxesOverlapHorizontally(fromBox, toBox)) {
    return { fromEdge: 'right', toEdge: 'right' };
  }
  const fromIsLeft = fromCenter < toCenter;
  return {
    fromEdge: fromIsLeft ? 'right' : 'left',
    toEdge: fromIsLeft ? 'left' : 'right',
  };
}

function routeFree(fromBox: CardBox, toBox: CardBox, from: Point, to: Point, laneOffset: number): Point[] {
  const points: Point[] = [];
  appendPoint(points, from.x, from.y);
  const gutter = boxesOverlapHorizontally(fromBox, toBox)
    ? Math.max(fromBox.x + fromBox.width, toBox.x + toBox.width) + 16 + laneOffset
    : ((fromBox.x < toBox.x
      ? fromBox.x + fromBox.width + toBox.x
      : toBox.x + toBox.width + fromBox.x) / 2) + laneOffset;
  appendPoint(points, gutter, from.y);
  appendPoint(points, gutter, to.y);
  appendPoint(points, to.x, to.y);
  return points;
}

function routeEdges(fromBox: CardBox, toBox: CardBox): { fromEdge: 'left' | 'right'; toEdge: 'left' | 'right' } {
  if (fromBox.id === toBox.id || fromBox.col === toBox.col) {
    return { fromEdge: 'right', toEdge: 'right' };
  }
  if (Math.abs(fromBox.col - toBox.col) === 1) {
    const fromIsLeft = fromBox.col < toBox.col;
    return {
      fromEdge: fromIsLeft ? 'right' : 'left',
      toEdge: fromIsLeft ? 'left' : 'right',
    };
  }
  const goingRight = toBox.col > fromBox.col;
  return {
    fromEdge: goingRight ? 'right' : 'left',
    toEdge: goingRight ? 'left' : 'right',
  };
}

function routeAroundCards(fromBox: CardBox, toBox: CardBox, from: Point, to: Point, channels: Channels, laneOffset: number): Point[] {
  const points: Point[] = [];
  appendPoint(points, from.x, from.y);

  if (fromBox.id === toBox.id || fromBox.col === toBox.col) {
    const gutter = channels.vertical[fromBox.col + 1] + laneOffset;
    appendPoint(points, gutter, from.y);
    appendPoint(points, gutter, to.y);
    appendPoint(points, to.x, to.y);
    return points;
  }

  if (Math.abs(fromBox.col - toBox.col) === 1) {
    const gutter = channels.vertical[Math.min(fromBox.col, toBox.col) + 1] + laneOffset;
    appendPoint(points, gutter, from.y);
    appendPoint(points, gutter, to.y);
    appendPoint(points, to.x, to.y);
    return points;
  }

  const goingRight = toBox.col > fromBox.col;
  const sourceGutter = channels.vertical[goingRight ? fromBox.col + 1 : fromBox.col] + laneOffset;
  const targetGutter = channels.vertical[goingRight ? toBox.col : toBox.col + 1] + laneOffset;
  const gapIndex = fromBox.row === toBox.row
    ? (fromBox.row < channels.rowCount - 1 ? fromBox.row + 1 : fromBox.row)
    : (toBox.row > fromBox.row ? fromBox.row + 1 : fromBox.row);
  const gap = channels.horizontal[gapIndex] + laneOffset;
  appendPoint(points, sourceGutter, from.y);
  appendPoint(points, sourceGutter, gap);
  appendPoint(points, targetGutter, gap);
  appendPoint(points, targetGutter, to.y);
  appendPoint(points, to.x, to.y);
  return points;
}

function pointsToPath(points: Point[]) {
  if (points.length === 0) return '';
  const simplified = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1];
    const current = points[index];
    const next = points[index + 1];
    const vertical = previous.x === current.x && current.x === next.x;
    const horizontal = previous.y === current.y && current.y === next.y;
    if (!vertical && !horizontal) simplified.push(current);
  }
  simplified.push(points[points.length - 1]);
  return simplified.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

interface ErDiagramTabProps {
  metadata: ErDiagramTabMetadata;
}

function tableLocation(table: ErTable, metadata: ErDiagramTabMetadata) {
  return {
    catalog: table.catalog || metadata.catalog || '',
    schema: table.schema || metadata.schema || '',
  };
}

export function ErDiagramTab({ metadata }: ErDiagramTabProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const openTab = useWorkspaceStore((state) => state.openTab);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const updateTabContent = useWorkspaceStore((state) => state.updateTabContent);
  const updateTabMetadata = useWorkspaceStore((state) => state.updateTabMetadata);
  const switchTab = useWorkspaceStore((state) => state.switchTab);
  const tableDblClickConsoleTarget = useWorkspaceStore((state) => state.tableDblClickConsoleTarget);
  const markerPrefix = useId().replace(/:/g, '');
  const [diagram, setDiagram] = useState<ErDiagram | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<ColumnFocus | null>(null);
  const [pinned, setPinned] = useState<ColumnFocus | null>(null);
  const [collapseJunctionTables, setCollapseJunctionTables] = useState(false);
  const [lines, setLines] = useState<RelationLine[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingTableId, setDraggingTableId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [tableNameFilter, setTableNameFilter] = useState('');
  const [exactTableFilter, setExactTableFilter] = useState(false);
  const drag = useRef<{
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
    x: number;
    y: number;
  } | null>(null);
  const viewRef = useRef(view);
  if (!drag.current) viewRef.current = view;
  const cardDrag = useRef<{ id: string; pointerX: number; pointerY: number; x: number; y: number; moved: boolean } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const revealedFocusKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setHover(null);
    setPinned(null);
    setCollapseJunctionTables(false);
    setTableNameFilter('');
    setExactTableFilter(false);
    setPositions({});
    setDraggingTableId(null);
    tableService.getErDiagram(
      String(metadata.connectionId),
      metadata.catalog ?? undefined,
      metadata.schema ?? undefined,
    ).then((result) => {
      if (!cancelled) setDiagram(result);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : t(I18N_KEYS.EXPLORER.ER_DIAGRAM_FAILED));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [metadata.catalog, metadata.connectionId, metadata.schema, t]);

  const junctionTables = useMemo(() => {
    const tables = new Set<string>();
    diagram?.relations.forEach((relation) => {
      const id = junctionTableId(relation);
      if (id) tables.add(id);
    });
    return tables;
  }, [diagram]);
  const collapsed = useMemo(
    () => (diagram ? collapseJunctions(diagram, collapseJunctionTables) : null),
    [collapseJunctionTables, diagram],
  );
  const shown = useMemo(
    () => (collapsed ? filterTablesByName(collapsed, tableNameFilter, exactTableFilter) : null),
    [collapsed, exactTableFilter, tableNameFilter],
  );

  useEffect(() => {
    const visible = new Set(shown?.tables.map((table) => tableId(table)) ?? []);
    setHover((current) => (current && !visible.has(current.tableId) ? null : current));
    setPinned((current) => (current && !visible.has(current.tableId) ? null : current));
  }, [shown]);

  const layout = useMemo(() => (shown ? layoutCards(shown) : null), [shown]);
  const placedBoxes = useMemo(() => {
    if (!layout) return [];
    return layout.boxes.map((box) => {
      const moved = positions[box.id];
      return moved ? { ...box, x: moved.x, y: moved.y } : box;
    });
  }, [layout, positions]);
  const canvasSize = useMemo(() => {
    if (!layout) return { width: 0, height: 0 };
    return placedBoxes.reduce((size, box) => ({
      width: Math.max(size.width, box.x + box.width + 24),
      height: Math.max(size.height, box.y + box.height + 24),
    }), { width: layout.width, height: layout.height });
  }, [layout, placedBoxes]);
  const boxById = useMemo(() => {
    const map = new Map<string, CardBox>();
    placedBoxes.forEach((box) => map.set(box.id, box));
    return map;
  }, [placedBoxes]);
  const layoutBoxById = useMemo(() => {
    const map = new Map<string, CardBox>();
    layout?.boxes.forEach((box) => map.set(box.id, box));
    return map;
  }, [layout]);
  const layoutMoved = Object.keys(positions).length > 0;
  const linkedColumns = useMemo(() => {
    const linked = new Set<string>();
    shown?.relations.forEach((relation) => {
      sideColumns(relation, 'from').forEach((column) => linked.add(columnKey(relationFromId(relation), column)));
      sideColumns(relation, 'to').forEach((column) => linked.add(columnKey(relationToId(relation), column)));
    });
    return linked;
  }, [shown]);

  const active = hover ?? pinned;
  const activeRelations = useMemo(
    () => (shown && active ? shown.relations.filter((relation) => relationTouches(relation, active)) : []),
    [active, shown],
  );
  const highlightedColumns = useMemo(() => {
    const highlighted = new Set<string>();
    activeRelations.forEach((relation) => {
      sideColumns(relation, 'from').forEach((column) => highlighted.add(columnKey(relationFromId(relation), column)));
      sideColumns(relation, 'to').forEach((column) => highlighted.add(columnKey(relationToId(relation), column)));
    });
    return highlighted;
  }, [activeRelations]);

  const measureLines = useCallback((reveal: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas || !active || activeRelations.length === 0) {
      revealedFocusKey.current = null;
      setLines((current) => (current.length === 0 ? current : []));
      return;
    }
    const focusKey = columnKey(active.tableId, active.column);
    if (reveal) {
      const revealToken = `${focusKey}\0${activeRelations.map((relation, index) => (
        `${index}:${relationMapping(relation)}:${cardinalityLabel(relation)}`
      )).join('\0')}`;
      if (revealedFocusKey.current !== revealToken) {
        revealedFocusKey.current = revealToken;
        const skipScroller = rowRefs.current.get(focusKey)?.parentElement ?? null;
        const peerKeys = new Set<string>();
        activeRelations.forEach((relation) => {
          sideColumns(relation, 'from').forEach((column) => peerKeys.add(columnKey(relationFromId(relation), column)));
          sideColumns(relation, 'to').forEach((column) => peerKeys.add(columnKey(relationToId(relation), column)));
        });
        peerKeys.forEach((key) => {
          if (key === focusKey) return;
          const row = rowRefs.current.get(key);
          if (row) revealRow(row, view.scale, skipScroller);
        });
      }
    }
    const channels = buildChannels(layout?.boxes ?? []);
    const laneSpread = 8;
    const next: RelationLine[] = [];
    activeRelations.forEach((relation, index) => {
      const fromId = relationFromId(relation);
      const toId = relationToId(relation);
      const anchors = anchorColumns(relation, active);
      const fromRow = rowRefs.current.get(columnKey(fromId, anchors.from));
      const toRow = rowRefs.current.get(columnKey(toId, anchors.to));
      const custom = positions[fromId] != null || positions[toId] != null;
      const fromBox = (custom ? boxById : layoutBoxById).get(fromId);
      const toBox = (custom ? boxById : layoutBoxById).get(toId);
      if (!fromRow || !toRow || !fromBox || !toBox) return;
      const edges = custom ? routeEdgesFree(fromBox, toBox) : routeEdges(fromBox, toBox);
      const from = endpoint(canvas, fromRow, edges.fromEdge, view.scale);
      const to = endpoint(canvas, toRow, edges.toEdge, view.scale);
      const lane = index - (activeRelations.length - 1) / 2;
      const laneOffset = Math.max(-10, Math.min(10, lane * laneSpread));
      const marks = endMarks(relation);
      const label = `${relationMapping(relation)} ${cardinalityLabel(relation)}`;
      next.push({
        key: `${label}-${index}`,
        d: pointsToPath(custom
          ? routeFree(fromBox, toBox, from, to, laneOffset)
          : routeAroundCards(fromBox, toBox, from, to, channels, laneOffset)),
        cross: isCrossRelation(relation),
        manyToMany: relation.cardinality === 'MANY_TO_MANY',
        fromMark: marks.from,
        toMark: marks.to,
      });
    });
    setLines((current) => {
      if (current.length === next.length && current.every((line, index) => (
        line.key === next[index].key
        && line.d === next[index].d
        && line.fromMark === next[index].fromMark
        && line.toMark === next[index].toMark
        && line.manyToMany === next[index].manyToMany
        && line.cross === next[index].cross
      ))) {
        return current;
      }
      return next;
    });
  }, [active, activeRelations, boxById, layout, layoutBoxById, positions, view.scale]);

  useLayoutEffect(() => {
    measureLines(true);
  }, [measureLines, layout]);

  const paintCanvas = (x: number, y: number, scale: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };

  const finishPan = () => {
    const pan = drag.current;
    if (!pan) return;
    drag.current = null;
    viewRef.current = { ...viewRef.current, x: pan.x, y: pan.y };
    setView((current) => (
      current.x === pan.x && current.y === pan.y ? current : { ...current, x: pan.x, y: pan.y }
    ));
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    setView((current) => {
      const pan = drag.current;
      const base = pan ? { ...current, x: pan.x, y: pan.y } : current;
      const next = zoomDiagramView(base, pointerX, pointerY, event.deltaY);
      if (pan) {
        pan.originX = next.x;
        pan.originY = next.y;
        pan.x = next.x;
        pan.y = next.y;
        pan.pointerX = event.clientX;
        pan.pointerY = event.clientY;
      }
      viewRef.current = next;
      paintCanvas(next.x, next.y, next.scale);
      return next;
    });
  };

  const fitToWindow = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const fitted = fitDiagramView(placedBoxes, viewport.clientWidth, viewport.clientHeight);
    if (fitted) setView(fitted);
  };

  const themeColor = (name: string, fallback: string) => (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  );

  const exportImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !shown || shown.tables.length === 0 || exporting) return;
    const scrollTops = new Map<string, number>();
    canvas.querySelectorAll<HTMLElement>('[data-er-scroller]').forEach((node) => {
      const id = node.getAttribute('data-er-scroller');
      if (id) scrollTops.set(id, node.scrollTop);
    });
    const scene: ErExportScene = {
      width: canvasSize.width,
      height: canvasSize.height,
      background: themeColor('--bg-main', '#f4f7fb'),
      grid: themeColor('--border-color', '#d8e1eb'),
      cardBackground: themeColor('--bg-popup', '#ffffff'),
      border: themeColor('--border-color', '#d8e1eb'),
      textPrimary: themeColor('--text-primary', '#172133'),
      textSecondary: themeColor('--text-secondary', '#5f6f86'),
      typeColor: '#0ea5e9',
      keyColor: '#f59e0b',
      highlight: 'rgba(225, 29, 72, 0.15)',
      cards: shown.tables.flatMap((table) => {
        const id = tableId(table);
        const box = boxById.get(id);
        if (!box) return [];
        const scrollerId = encodeURIComponent(id);
        return [{
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          title: tableTitle(table),
          external: Boolean(table.external),
          badges: [
            table.external ? { text: t(I18N_KEYS.EXPLORER.ER_DIAGRAM_EXTERNAL), color: themeColor('--text-secondary', '#5f6f86') } : null,
            junctionTables.has(id) ? { text: t(I18N_KEYS.EXPLORER.ER_DIAGRAM_JUNCTION), color: VIOLET } : null,
          ].filter((badge): badge is { text: string; color: string } => badge !== null),
          scrollTop: scrollTops.get(scrollerId) ?? 0,
          columns: table.columns.map((column) => {
            const key = columnKey(id, column.name);
            return {
              name: column.name,
              typeName: column.typeName,
              comment: column.comment ?? '',
              primaryKey: column.primaryKey,
              linked: linkedColumns.has(key),
              highlighted: highlightedColumns.has(key),
            };
          }),
        }];
      }),
      lines: lines.map((line) => ({
        d: line.d,
        color: line.manyToMany ? VIOLET : ROSE,
        dashed: line.cross,
        fromMark: line.fromMark,
        toMark: line.toMark,
      })),
    };
    setExporting(true);
    try {
      const blob = await renderErDiagramPng(scene);
      const name = metadata.databaseName || metadata.schemaName || metadata.connectionName || 'er-diagram';
      downloadBlob(blob, erDiagramFilename(name));
      toast.success(t(I18N_KEYS.EXPLORER.ER_DIAGRAM_EXPORTED));
    } catch {
      toast.error(t(I18N_KEYS.EXPLORER.ER_DIAGRAM_EXPORT_FAILED));
    } finally {
      setExporting(false);
    }
  };

  const togglePin = (focus: ColumnFocus) => {
    setPinned((current) => (
      current?.tableId === focus.tableId && current.column === focus.column ? null : focus
    ));
  };

  const openTableData = (table: ErTable) => {
    const { catalog, schema } = tableLocation(table, metadata);
    const connectionId = Number(metadata.connectionId);
    openTab({
      id: `table-${connectionId}-${catalog}-${schema}-${table.name}`,
      name: table.name,
      type: 'table',
      content: '',
      metadata: {
        connectionId,
        dbType: metadata.dbType,
        connectionName: metadata.connectionName,
        databaseName: catalog || schema || null,
        schemaName: schema || null,
        objectName: table.name,
        objectType: 'table',
        catalog: catalog || undefined,
        schema: schema || undefined,
      },
    });
  };

  const openTableDdl = async (table: ErTable) => {
    const { catalog, schema } = tableLocation(table, metadata);
    const connectionId = Number(metadata.connectionId);
    const consoleTabs = tabs.filter((tab) => (
      tab.type === 'file'
      && (tab.metadata as ConsoleTabMetadata | undefined)?.connectionId === connectionId
    ));
    const reuse = tableDblClickConsoleTarget === TableDblClickConsoleTargetEnum.REUSE && consoleTabs.length > 0;
    const tabId = reuse
      ? consoleTabs[0].id
      : `ddl-${connectionId}-${catalog}-${schema}-${table.name}`;
    const consoleMetadata = {
      connectionId,
      connectionName: metadata.connectionName,
      databaseName: catalog || schema || null,
      schemaName: schema || null,
      dbType: metadata.dbType,
    };
    if (reuse) {
      updateTabMetadata(tabId, consoleMetadata);
      switchTab(tabId);
    } else {
      openTab({
        id: tabId,
        name: table.name,
        type: 'file',
        content: '',
        metadata: consoleMetadata,
      });
    }
    try {
      const ddl = await tableService.getTableDdl(String(connectionId), table.name, catalog, schema);
      updateTabContent(tabId, ddl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t(I18N_KEYS.EXPLORER.LOAD_DDL_FAILED);
      updateTabContent(tabId, `-- ${message}\n`);
      toast.error(message);
    }
  };

  const openExternalErDiagram = (table: ErTable) => {
    if (!table.external) return;
    const catalog = table.catalog || '';
    const schema = table.schema || '';
    if (catalog === (metadata.catalog || '') && schema === (metadata.schema || '')) return;
    const scope = schema || catalog;
    if (!scope) return;
    const connectionId = Number(metadata.connectionId);
    openTab({
      id: `er-${connectionId}-${catalog}-${schema}`,
      name: `ER ${scope}`,
      type: 'er',
      content: '',
      metadata: {
        connectionId,
        dbType: metadata.dbType,
        connectionName: metadata.connectionName,
        databaseName: catalog || schema || null,
        schemaName: schema || null,
        catalog: catalog || null,
        schema: schema || null,
      },
    });
  };

  const relationSummary = activeRelations.map((relation) => {
    const via = viaTableName(relation);
    const text = `${relationMapping(relation)} ${cardinalityLabel(relation)}`;
    return via ? `${text} ${t(I18N_KEYS.EXPLORER.ER_DIAGRAM_VIA, { table: via })}` : text;
  }).join(' · ');
  const statusText = relationSummary || t(I18N_KEYS.EXPLORER.ER_DIAGRAM_HINT);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b theme-border text-xs theme-text-secondary">
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <span className="theme-text-primary font-medium">{t(I18N_KEYS.EXPLORER.ER_DIAGRAM)}</span>
          <span>{metadata.databaseName || metadata.schemaName || metadata.connectionName}</span>
          {shown && (
            <span>
              {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_SUMMARY, {
                tables: shown.tables.length,
                relations: shown.relations.length,
              })}
            </span>
          )}
          {diagram?.truncated && (
            <span>{t(I18N_KEYS.EXPLORER.ER_DIAGRAM_TRUNCATED, {
              count: diagram.tables.filter((table) => !table.external).length,
            })}</span>
          )}
          {diagram?.externalTruncated && (
            <span>{t(I18N_KEYS.EXPLORER.ER_DIAGRAM_EXTERNAL_TRUNCATED, {
              count: diagram.tables.filter((table) => table.external).length,
            })}</span>
          )}
          {junctionTables.size > 0 && (
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                className="accent-violet-600"
                checked={collapseJunctionTables}
                onChange={(event) => setCollapseJunctionTables(event.target.checked)}
              />
              {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_COLLAPSE_JUNCTIONS)}
            </label>
          )}
          {diagram && diagram.tables.length > 0 && (
            <>
              <input
                type="search"
                value={tableNameFilter}
                onChange={(event) => setTableNameFilter(event.target.value)}
                placeholder={t(I18N_KEYS.EXPLORER.ER_DIAGRAM_FILTER)}
                aria-label={t(I18N_KEYS.EXPLORER.ER_DIAGRAM_FILTER)}
                className="h-6 w-52 rounded border theme-border bg-transparent px-2 text-[11px] theme-text-primary outline-none"
              />
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  className="accent-violet-600"
                  checked={exactTableFilter}
                  onChange={(event) => setExactTableFilter(event.target.checked)}
                />
                {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_FILTER_EXACT)}
              </label>
            </>
          )}
          {shown && shown.tables.length > 0 && (
            <button
              type="button"
              className="rounded border theme-border px-2 py-0.5 theme-text-primary"
              onClick={fitToWindow}
            >
              {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_FIT)}
            </button>
          )}
          {shown && shown.tables.length > 0 && (
            <button
              type="button"
              className="rounded border theme-border px-2 py-0.5 theme-text-primary disabled:opacity-40"
              disabled={exporting}
              onClick={() => { void exportImage(); }}
            >
              {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_EXPORT)}
            </button>
          )}
          {shown && shown.tables.length > 0 && (
            <button
              type="button"
              className="rounded border theme-border px-2 py-0.5 theme-text-primary disabled:opacity-40"
              disabled={!layoutMoved}
              onClick={() => setPositions({})}
            >
              {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_RESET_LAYOUT)}
            </button>
          )}
          {shown && shown.tables.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 border-l theme-border pl-3">
              <LegendSample mark="one" label={t(I18N_KEYS.EXPLORER.ER_DIAGRAM_LEGEND_ONE)} color={ROSE} />
              <LegendSample mark="many" label={t(I18N_KEYS.EXPLORER.ER_DIAGRAM_LEGEND_MANY)} color={ROSE} />
              <LegendSample mark="many" label={t(I18N_KEYS.EXPLORER.ER_DIAGRAM_LEGEND_MANY_TO_MANY)} color={VIOLET} />
              <LegendSample label={t(I18N_KEYS.EXPLORER.ER_DIAGRAM_LEGEND_CROSS)} dashed />
            </span>
          )}
        </div>
        <div className="flex h-7 min-w-0 items-center overflow-hidden border-t theme-border px-3" title={statusText}>
          {activeRelations.length > 0 ? (
            <span className="min-w-0 truncate theme-text-primary">
              {activeRelations.map((relation, index) => {
                const via = viaTableName(relation);
                return (
                  <span key={`${relationMapping(relation)}-${index}`}>
                    {index > 0 ? <span className="px-1.5 theme-text-secondary">·</span> : null}
                    {relationMapping(relation)}
                    {' '}
                    <span className={relation.cardinality === 'MANY_TO_MANY' ? 'text-violet-600' : undefined}>
                      {cardinalityLabel(relation)}
                    </span>
                    {via ? ` ${t(I18N_KEYS.EXPLORER.ER_DIAGRAM_VIA, { table: via })}` : ''}
                  </span>
                );
              })}
            </span>
          ) : (
            <span className="min-w-0 truncate">{statusText}</span>
          )}
        </div>
      </div>
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 select-none overflow-hidden"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--border-color) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
          cursor: drag.current ? 'grabbing' : 'grab',
        }}
        onWheel={onWheel}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
          const origin = viewRef.current;
          drag.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            originX: origin.x,
            originY: origin.y,
            x: origin.x,
            y: origin.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pan = drag.current;
          if (!pan) return;
          pan.x = pan.originX + event.clientX - pan.pointerX;
          pan.y = pan.originY + event.clientY - pan.pointerY;
          paintCanvas(pan.x, pan.y, viewRef.current.scale);
        }}
        onPointerUp={finishPan}
        onPointerCancel={finishPan}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm theme-text-secondary">
            {t(I18N_KEYS.EXPLORER.LOADING)}
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-sm text-destructive">
            {error}
          </div>
        )}
        {!loading && diagram && diagram.tables.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm theme-text-secondary">
            {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_EMPTY)}
          </div>
        )}
        {!loading && diagram && diagram.tables.length > 0 && shown && shown.tables.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm theme-text-secondary">
            {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_FILTER_EMPTY)}
          </div>
        )}
        {layout && shown && shown.tables.length > 0 && (
          <div
            ref={canvasRef}
            style={{
              transform: `translate(${drag.current?.x ?? view.x}px, ${drag.current?.y ?? view.y}px) scale(${view.scale})`,
              transformOrigin: '0 0',
              width: canvasSize.width,
              height: canvasSize.height,
              position: 'relative',
            }}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" width={canvasSize.width} height={canvasSize.height}>
              <defs>
                <CardinalityMarker id={`${markerPrefix}-one`} mark="one" color={ROSE} />
                <CardinalityMarker id={`${markerPrefix}-many`} mark="many" color={ROSE} />
                <CardinalityMarker id={`${markerPrefix}-one-many`} mark="one" color={VIOLET} />
                <CardinalityMarker id={`${markerPrefix}-many-many`} mark="many" color={VIOLET} />
              </defs>
              {lines.map((line) => (
                <path
                  key={line.key}
                  d={line.d}
                  fill="none"
                  stroke={line.manyToMany ? VIOLET : ROSE}
                  strokeWidth="1.6"
                  strokeDasharray={line.cross ? '5 4' : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  markerStart={`url(#${markerPrefix}-${line.fromMark}${line.manyToMany ? '-many' : ''})`}
                  markerEnd={`url(#${markerPrefix}-${line.toMark}${line.manyToMany ? '-many' : ''})`}
                />
              ))}
            </svg>
            {shown.tables.map((table) => {
              const id = tableId(table);
              const box = boxById.get(id);
              const title = tableTitle(table);
              if (!box) return null;
              return (
                <div
                  key={id}
                  className={`absolute overflow-hidden rounded-md border theme-bg-popup shadow-sm ${table.external ? 'border-dashed border-rose-400/80' : 'theme-border'}`}
                  style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                  onDoubleClick={(event) => {
                    if (!table.external) return;
                    event.stopPropagation();
                    openExternalErDiagram(table);
                  }}
                >
                  <div
                    className="flex h-[34px] cursor-grab select-none items-center gap-1 border-b theme-border px-2 text-xs font-semibold theme-text-primary active:cursor-grabbing"
                    style={{ cursor: draggingTableId === id ? 'grabbing' : undefined }}
                    title={table.external
                      ? `${t(I18N_KEYS.EXPLORER.ER_DIAGRAM_OPEN_EXTERNAL)}。${t(I18N_KEYS.EXPLORER.ER_DIAGRAM_DRAG_TABLE)}`
                      : t(I18N_KEYS.EXPLORER.ER_DIAGRAM_DRAG_TABLE)}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      cardDrag.current = {
                        id,
                        pointerX: event.clientX,
                        pointerY: event.clientY,
                        x: box.x,
                        y: box.y,
                        moved: false,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const current = cardDrag.current;
                      if (!current || current.id !== id) return;
                      const distance = Math.hypot(event.clientX - current.pointerX, event.clientY - current.pointerY);
                      if (!current.moved && distance < 4) return;
                      current.moved = true;
                      setDraggingTableId(id);
                      const x = Math.max(CARD_EDGE, current.x + (event.clientX - current.pointerX) / view.scale);
                      const y = Math.max(CARD_EDGE, current.y + (event.clientY - current.pointerY) / view.scale);
                      setPositions((previous) => ({ ...previous, [id]: { x, y } }));
                    }}
                    onPointerUp={() => {
                      if (cardDrag.current?.id !== id) return;
                      cardDrag.current = null;
                      setDraggingTableId(null);
                    }}
                    onPointerCancel={() => {
                      if (cardDrag.current?.id !== id) return;
                      cardDrag.current = null;
                      setDraggingTableId(null);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate" title={table.comment || title}>{title}</span>
                    {table.external && (
                      <span className="shrink-0 rounded px-1 text-[10px] font-normal theme-text-secondary">
                        {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_EXTERNAL)}
                      </span>
                    )}
                    {junctionTables.has(id) && (
                      <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[10px] font-normal text-violet-600">
                        {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_JUNCTION)}
                      </span>
                    )}
                    <button
                      type="button"
                      className="shrink-0 rounded border theme-border px-1 text-[10px] font-normal theme-text-primary"
                      title={t(I18N_KEYS.EXPLORER.VIEW_DATA)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        openTableData(table);
                      }}
                    >
                      {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_OPEN_DATA)}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded border theme-border px-1 text-[10px] font-normal theme-text-primary"
                      title={t(I18N_KEYS.EXPLORER.VIEW_DDL)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        void openTableDdl(table);
                      }}
                    >
                      {t(I18N_KEYS.EXPLORER.ER_DIAGRAM_OPEN_DDL)}
                    </button>
                  </div>
                  <div
                    className="max-h-[264px] overflow-auto"
                    data-er-scroller={encodeURIComponent(id)}
                    onScroll={() => measureLines(false)}
                    onWheel={(event) => event.stopPropagation()}
                  >
                    {table.columns.map((column) => {
                      const key = columnKey(id, column.name);
                      const linked = linkedColumns.has(key);
                      const highlighted = highlightedColumns.has(key);
                      return (
                        <div
                          key={column.name}
                          ref={(node) => {
                            if (node) rowRefs.current.set(key, node);
                            else rowRefs.current.delete(key);
                          }}
                          className={`flex h-[22px] items-center gap-1 px-2 text-[11px] ${highlighted ? 'bg-rose-500/15' : ''} ${linked ? 'cursor-pointer' : ''}`}
                          onPointerDown={(event) => {
                            if (!linked) return;
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            if (!linked || event.detail > 1) return;
                            event.stopPropagation();
                            togglePin({ tableId: id, column: column.name });
                          }}
                          onPointerEnter={() => {
                            if (drag.current || !linked) return;
                            setHover({ tableId: id, column: column.name });
                          }}
                          onPointerLeave={() => {
                            if (drag.current) return;
                            setHover((current) => (
                              current?.tableId === id && current.column === column.name ? null : current
                            ));
                          }}
                        >
                          <span className="w-3 shrink-0 text-amber-500">
                            {column.primaryKey ? <KeyRound className="h-3 w-3" /> : null}
                          </span>
                          <span className="flex w-2 shrink-0 justify-center">
                            {linked ? <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> : null}
                          </span>
                          <span className="w-[38%] truncate theme-text-primary" title={column.name}>{column.name}</span>
                          <span className="w-[28%] truncate text-sky-500" title={column.typeName}>{column.typeName}</span>
                          <span className="min-w-0 flex-1 truncate theme-text-secondary" title={column.comment}>{column.comment}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
