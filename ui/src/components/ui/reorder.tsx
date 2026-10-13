import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/util/cn";

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DROP_MS = 170;

const lockX: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const lockY: Modifier = ({ transform }) => ({ ...transform, y: 0 });

const keys = new WeakMap<object, string>();
let keySeq = 0;

/** Stable id for an object dnd-kit can follow across reorders. */
export const stableDragId = (item: object) => {
  let id = keys.get(item);
  if (!id) {
    keySeq += 1;
    id = `d${keySeq}`;
    keys.set(item, id);
  }
  return id;
};

let suppressClick = false;
let clearTimer = 0;

const armDragClickGuard = () => {
  suppressClick = true;
};

const releaseDragClickGuard = () => {
  window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    suppressClick = false;
  }, 80);
};

/** A finished drag still emits a click. Swallow that one click. */
export const consumeDragClick = () => {
  if (!suppressClick) return false;
  suppressClick = false;
  window.clearTimeout(clearTimer);
  return true;
};

/**
 * Dashed frame the dragged row sits in while it is moving. It matches the
 * row's box exactly and paints above the row, so the outline is never clipped
 * by the row's own content.
 */
const DropPlaceholder = () => (
  <div
    aria-hidden
    className="pointer-events-none absolute inset-0 z-20 rounded-lg border border-dashed border-white/30 bg-white/5"
  />
);

const sortableTransition = { duration: DROP_MS, easing: EASE };

export const ReorderList = ({
  ids,
  axis,
  onMove,
  onActiveChange,
  children,
}: {
  ids: string[];
  axis: "x" | "y";
  onMove: (from: number, to: number) => void;
  onActiveChange?: (id: string | null) => void;
  children: ReactNode;
}) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const idsRef = useRef(ids);
  const onMoveRef = useRef(onMove);
  const onActiveRef = useRef(onActiveChange);
  const snapRef = useRef<HTMLElement | null>(null);
  idsRef.current = ids;
  onMoveRef.current = onMove;
  onActiveRef.current = onActiveChange;

  const releaseSnap = () => {
    if (!snapRef.current) return;
    snapRef.current.style.scrollSnapType = "";
    snapRef.current = null;
  };

  useEffect(() => () => releaseSnap(), []);

  const onDragStart = (event: DragStartEvent) => {
    onActiveRef.current?.(String(event.active.id));
    armDragClickGuard();
    const target = event.activatorEvent.target;
    if (target instanceof Element) {
      const scroller = target.closest(".snap-x");
      if (scroller instanceof HTMLElement) {
        snapRef.current = scroller;
        scroller.style.scrollSnapType = "none";
      }
    }
  };

  const finish = (event: DragEndEvent | null) => {
    const current = idsRef.current;
    if (event?.over) {
      const from = current.indexOf(String(event.active.id));
      const to = current.indexOf(String(event.over.id));
      if (from >= 0 && to >= 0 && from !== to) onMoveRef.current(from, to);
    }
    onActiveRef.current?.(null);
    releaseSnap();
    releaseDragClickGuard();
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={axis === "y" ? [lockX] : [lockY]}
      measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
      autoScroll={{ acceleration: 18 }}
      onDragStart={onDragStart}
      onDragEnd={finish}
      onDragCancel={() => finish(null)}
    >
      <SortableContext items={ids} strategy={axis === "y" ? verticalListSortingStrategy : horizontalListSortingStrategy}>
        {children}
      </SortableContext>
      {/*
        Mounted, but empty. It keeps dnd-kit placing the dragged row with the
        sort strategy (at the slot it will land in) instead of pinning it to the
        pointer, while the row itself keeps rendering its real content.
      */}
      <DragOverlay dropAnimation={null} className="pointer-events-none" />
    </DndContext>
  );
};

export const ReorderItem = ({
  id,
  disabled = false,
  offsetY,
  height,
  className,
  children,
}: {
  id: string;
  /**
   * `true` only stops the item from being dragged (dnd-kit keeps it droppable
   * for backwards compatibility). Pass `{ draggable: true, droppable: true }`
   * to pin it: it can neither be dragged nor be a drop target, so no other row
   * can land on it and take its slot.
   */
  disabled?: boolean | { draggable?: boolean; droppable?: boolean };
  /** Virtual-row offset. The sortable delta is added to it. */
  offsetY?: number;
  height?: number;
  className?: string;
  children: ReactNode;
}) => {
  const dragDisabled = disabled === true || (typeof disabled === "object" && Boolean(disabled.draggable));
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
    transition: sortableTransition,
  });
  // Virtual rows must be placed with `top`. dnd-kit measures droppables with the
  // transform removed, so a translateY would make every row occupy the same box.
  // While this row is the one being dragged, skip the transition so it tracks the
  // pointer exactly (otherwise the row and its dashed frame lag behind).
  const followTransition = isDragging ? undefined : transition;
  const style: CSSProperties =
    offsetY == null
      ? { transform: CSS.Translate.toString(transform), transition: followTransition, zIndex: isDragging ? 2 : undefined }
      : {
          position: "absolute",
          top: offsetY,
          left: 0,
          width: "100%",
          height,
          transform: CSS.Translate.toString(transform),
          transition: followTransition,
          zIndex: isDragging ? 2 : undefined,
        };

  return (
    <div
      ref={setNodeRef}
      data-drag-item={dragDisabled ? undefined : ""}
      style={style}
      className={cn("relative", !dragDisabled && "cursor-grab touch-none", className)}
      {...(dragDisabled ? {} : listeners)}
    >
      {isDragging && <DropPlaceholder />}
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
};
