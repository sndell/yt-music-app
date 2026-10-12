import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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

const HiddenId = createContext<string | null>(null);

const sortableTransition = { duration: DROP_MS, easing: EASE };

// Land on the row's on-screen box. The default animation uses a transform-agnostic
// rect, which is the slot the row started in, so the card flies back there.
const dropAnimation: DropAnimation = {
  duration: DROP_MS,
  easing: EASE,
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0" } },
  }),
  keyframes({ transform, active, dragOverlay }) {
    const visual = active.node.getBoundingClientRect();
    const final = {
      x: transform.initial.x - (dragOverlay.rect.left - visual.left),
      y: transform.initial.y - (dragOverlay.rect.top - visual.top),
      scaleX: transform.initial.scaleX,
      scaleY: transform.initial.scaleY,
    };
    return [
      { transform: CSS.Transform.toString(transform.initial) ?? "translate3d(0, 0, 0)" },
      { transform: CSS.Transform.toString(final) ?? "translate3d(0, 0, 0)" },
    ];
  },
};

export const ReorderList = ({
  ids,
  axis,
  onMove,
  onActiveChange,
  overlay,
  children,
}: {
  ids: string[];
  axis: "x" | "y";
  onMove: (from: number, to: number) => void;
  onActiveChange?: (id: string | null) => void;
  overlay: (id: string) => ReactNode;
  children: ReactNode;
}) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  const idsRef = useRef(ids);
  const onMoveRef = useRef(onMove);
  const onActiveRef = useRef(onActiveChange);
  const snapRef = useRef<HTMLElement | null>(null);
  const hideTimer = useRef(0);
  idsRef.current = ids;
  onMoveRef.current = onMove;
  onActiveRef.current = onActiveChange;

  const releaseSnap = () => {
    if (!snapRef.current) return;
    snapRef.current.style.scrollSnapType = "";
    snapRef.current = null;
  };

  useEffect(
    () => () => {
      releaseSnap();
      window.clearTimeout(hideTimer.current);
    },
    []
  );

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    window.clearTimeout(hideTimer.current);
    setActiveId(id);
    setHiddenId(id);
    onActiveRef.current?.(id);
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
    setActiveId(null);
    onActiveRef.current?.(null);
    releaseSnap();
    releaseDragClickGuard();
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHiddenId(null), DROP_MS);
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
      <HiddenId.Provider value={hiddenId}>
        <SortableContext items={ids} strategy={axis === "y" ? verticalListSortingStrategy : horizontalListSortingStrategy}>
          {children}
        </SortableContext>
      </HiddenId.Provider>
      <DragOverlay dropAnimation={dropAnimation} className="cursor-grabbing">
        {activeId ? overlay(activeId) : null}
      </DragOverlay>
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
  /** `true` disables the item. `{ draggable: true }` keeps it as a place to drop. */
  disabled?: boolean | { draggable?: boolean };
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
  const hiddenId = useContext(HiddenId);
  const conceal = isDragging || hiddenId === id;
  // Virtual rows must be placed with `top`. dnd-kit measures droppables with the
  // transform removed, so a translateY would make every row occupy the same box.
  const style: CSSProperties =
    offsetY == null
      ? { transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 2 : undefined }
      : {
          position: "absolute",
          top: offsetY,
          left: 0,
          width: "100%",
          height,
          transform: CSS.Translate.toString(transform),
          transition: isDragging ? undefined : transition,
          zIndex: isDragging ? 2 : undefined,
        };

  return (
    <div
      ref={setNodeRef}
      data-drag-item={dragDisabled ? undefined : ""}
      style={style}
      className={cn(!dragDisabled && "cursor-grab touch-none", conceal && "opacity-0", className)}
      {...(dragDisabled ? {} : listeners)}
    >
      {children}
    </div>
  );
};
