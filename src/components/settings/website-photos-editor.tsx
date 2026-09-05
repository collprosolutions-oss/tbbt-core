"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  abortWebsitePhotoUpload,
  authorizeWebsitePhotoUpload,
  finalizeWebsitePhotoUpload,
} from "@/app/actions/business-storage";
import {
  repositionPublicSiteImage,
  resetPublicSiteImage,
  type PublicSiteImageActionState,
} from "@/app/actions/public-site-images";
import { formatStorageBytes } from "@/lib/business-storage";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  PUBLIC_SITE_IMAGE_FILE_ACCEPT,
  PUBLIC_SITE_IMAGE_MAX_ZOOM,
  PUBLIC_SITE_IMAGE_MIN_ZOOM,
  PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE,
  PUBLIC_SITE_IMAGE_ZOOM_STEP,
  clampObjectZoom,
  clampPercent,
  evaluateWebsitePhotoSelection,
  publicImageFrameModel,
  splitObjectPosition,
  type PublicSiteImageEditorSlot,
} from "@/lib/public-site-images";
import { cn } from "@/lib/utils";

const emptyState: PublicSiteImageActionState = {};

function previewFrameClass(slot: PublicSiteImageEditorSlot) {
  if (slot.kind === "story") {
    return "relative h-72 w-full overflow-hidden rounded-md border bg-[#05070c]";
  }
  if (slot.kind === "category") {
    return slot.page === "home"
      ? "relative h-[13.5rem] w-full overflow-hidden rounded-[6px] border bg-[#05070c]"
      : "relative h-56 w-full overflow-hidden rounded-md border bg-[#05070c]";
  }
  return "relative h-[13rem] w-full overflow-hidden border bg-[#05070c] sm:h-[14.5rem]";
}

function previewHint(slot: PublicSiteImageEditorSlot) {
  if (slot.kind === "story") {
    return "Preview uses the About story photo frame.";
  }
  if (slot.kind === "category") {
    return slot.page === "home"
      ? "Preview uses the Home service-card frame."
      : "Preview uses the Services category photo frame.";
  }
  if (slot.page === "home") {
    return "Preview uses the same wide Home hero frame as the public website.";
  }
  return "Preview uses the public website hero frame.";
}

function SlotEditor({
  slot,
  businessId,
  storageConfigured,
  storageUsage,
  canEdit,
  heading,
}: {
  slot: PublicSiteImageEditorSlot;
  businessId: string;
  storageConfigured: boolean;
  storageUsage?: { usedBytes: number; limitBytes: number } | null;
  canEdit: boolean;
  heading?: string;
}) {
  const start = splitObjectPosition(slot.objectPosition);
  const [x, setX] = useState(start.x);
  const [y, setY] = useState(start.y);
  const [zoom, setZoom] = useState(clampObjectZoom(slot.objectZoom));
  const [saved, setSaved] = useState({
    x: start.x,
    y: start.y,
    zoom: clampObjectZoom(slot.objectZoom),
  });
  const [drag, setDrag] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [displaySrc, setDisplaySrc] = useState(slot.src);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [replaceState, setReplaceState] = useState<PublicSiteImageActionState>(emptyState);
  const [replacePending, setReplacePending] = useState(false);
  const [positionState, positionAction, positionPending] = useActionState(
    repositionPublicSiteImage,
    emptyState,
  );
  const [resetState, resetAction, resetPending] = useActionState(
    resetPublicSiteImage,
    emptyState,
  );
  const pending = replacePending || positionPending || resetPending;
  const error =
    fileError || replaceState.error || positionState.error || resetState.error;
  const message =
    replaceState.message || positionState.message || resetState.message;
  const previewSrc = localPreview ?? displaySrc;
  const canReplace = Boolean(selectedFile) && !pending;
  const unsaved = x !== saved.x || y !== saved.y || zoom !== saved.zoom;
  const defaultPos = splitObjectPosition(slot.defaultPosition);
  const previewFrame = publicImageFrameModel(`${x}% ${y}%`, zoom);
  const fileInputId = `website-photo-file-${slot.page}-${slot.slot.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const positionWasPending = useRef(false);
  useEffect(() => {
    setDisplaySrc(slot.src);
  }, [slot.src]);
  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);
  useEffect(() => {
    if (
      positionWasPending.current &&
      !positionPending &&
      positionState.message &&
      !positionState.error
    ) {
      setSaved({ x, y, zoom });
    }
    positionWasPending.current = positionPending;
  }, [positionPending, positionState.error, positionState.message, x, y, zoom]);

  function applyFromPointer(event: ReactPointerEvent<HTMLButtonElement>, nextX: number, nextY: number) {
    if (event.pointerId !== drag?.pointerId && drag) return;
    setX(clampPercent(nextX));
    setY(clampPercent(nextY));
  }

  function onPreviewPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!canEdit) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: x,
      originY: y,
    });
  }

  function onPreviewPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const moved =
      Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
    if (moved < 3) return;
    const deltaX = ((event.clientX - drag.startX) / rect.width) * 100;
    const deltaY = ((event.clientY - drag.startY) / rect.height) * 100;
    applyFromPointer(event, drag.originX - deltaX, drag.originY - deltaY);
  }

  function onPreviewPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const moved =
      Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
    if (moved < 3 && rect.width > 0 && rect.height > 0) {
      const nextX = ((event.clientX - rect.left) / rect.width) * 100;
      const nextY = ((event.clientY - rect.top) / rect.height) * 100;
      setX(clampPercent(nextX));
      setY(clampPercent(nextY));
    }
    setDrag(null);
  }

  function resetCropLocally() {
    setX(defaultPos.x);
    setY(defaultPos.y);
    setZoom(clampObjectZoom(slot.defaultZoom));
  }

  function onFileSelected(file: File | null) {
    if (!file) return;
    const inspection = evaluateWebsitePhotoSelection(file);
    if (!inspection.ok) {
      setFileError(inspection.error);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (localPreview) URL.revokeObjectURL(localPreview);
    const preview = URL.createObjectURL(file);
    setFileError(null);
    setSelectedFile(file);
    setLocalPreview(preview);
    setDisplaySrc(preview);
  }

  function openPhotoChooser() {
    const input = fileInputRef.current;
    if (!input || pending) return;
    input.value = "";
    input.click();
  }

  async function submitReplacement() {
    if (!selectedFile || replacePending) return;
    setReplacePending(true);
    setReplaceState({});
    let assetId = "";
    try {
      const authorized = await authorizeWebsitePhotoUpload({
        page: slot.page,
        slot: slot.slot,
        originalFilename: selectedFile.name,
        mimeType: selectedFile.type || "application/octet-stream",
        fileSizeBytes: selectedFile.size,
      });
      if (authorized.error || !authorized.assetId || !authorized.uploadUrl) {
        setReplaceState({ error: authorized.error || "That photo could not be authorized." });
        return;
      }
      assetId = authorized.assetId;
      const uploaded = await fetch(authorized.uploadUrl, {
        method: authorized.uploadMethod || "PUT",
        headers: authorized.uploadHeaders,
        body: selectedFile,
      });
      if (!uploaded.ok) {
        await abortWebsitePhotoUpload({ assetId });
        setReplaceState({
          error: "The photo could not be uploaded to file storage. Try again.",
        });
        return;
      }
      const finalized = await finalizeWebsitePhotoUpload({
        assetId,
        page: slot.page,
        slot: slot.slot,
      });
      if (finalized.error || !finalized.imageUrl) {
        setReplaceState({
          error: finalized.error || "That website photo could not be saved.",
        });
        return;
      }
      if (localPreview) URL.revokeObjectURL(localPreview);
      setLocalPreview(null);
      setSelectedFile(null);
      setFileError(null);
      setDisplaySrc(finalized.imageUrl);
      setReplaceState({ message: finalized.message, imageUrl: finalized.imageUrl });
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch {
      if (assetId) await abortWebsitePhotoUpload({ assetId }).catch(() => undefined);
      setReplaceState({ error: "That website photo could not be saved." });
    } finally {
      setReplacePending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{heading ?? slot.label}</p>
          <p className="text-sm text-muted-foreground">
            {slot.kind === "story"
              ? "About Our Story photograph. Layout stays the same."
              : slot.kind === "hero"
                ? slot.page === "about"
                  ? "About hero photograph. Layout stays the same."
                  : slot.page === "reviews"
                    ? "Reviews hero photograph. Layout stays the same."
                    : slot.page === "services"
                      ? "Services hero photograph. Layout stays the same."
                      : "Home hero photograph. Adjust zoom and position to match the live wide header."
                : slot.page === "services"
                  ? "Services category photograph only. The category name and services do not change."
                  : "Home category card photograph only. The category name and services do not change."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {unsaved ? (
            <p className="text-xs font-medium text-amber-700">Unsaved changes</p>
          ) : null}
          {slot.isOverride ? (
            <p className="text-xs font-medium text-primary">Custom photo</p>
          ) : (
            <p className="text-xs text-muted-foreground">Default photo</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Current image</p>
          <div className="relative aspect-square max-h-56 w-full overflow-hidden rounded-lg border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewSrc} alt="" className="size-full object-contain" />
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Live preview</p>
          <button
            type="button"
            onPointerDown={onPreviewPointerDown}
            onPointerMove={onPreviewPointerMove}
            onPointerUp={onPreviewPointerUp}
            onPointerCancel={() => setDrag(null)}
            className={cn(previewFrameClass(slot), canEdit && "cursor-grab active:cursor-grabbing")}
            aria-label={`Preview ${slot.label}. Drag to reposition, or use the sliders.`}
          >
            <div data-public-site-image-frame="" style={previewFrame.box}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewSrc}
                alt=""
                className="size-full"
                style={previewFrame.image}
                draggable={false}
              />
            </div>
          </button>
          <p className="mt-1 text-xs text-muted-foreground">{previewHint(slot)}</p>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {message && !error ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3">
        <label className="text-sm">
          Zoom {zoom.toFixed(2)}
          <input
            type="range"
            min={PUBLIC_SITE_IMAGE_MIN_ZOOM}
            max={PUBLIC_SITE_IMAGE_MAX_ZOOM}
            step={PUBLIC_SITE_IMAGE_ZOOM_STEP}
            value={zoom}
            disabled={!canEdit}
            onChange={(event) => setZoom(clampObjectZoom(Number(event.target.value)))}
            className="mt-1 w-full"
          />
        </label>
        <label className="text-sm">
          Move Left / Right
          <input
            type="range"
            min={0}
            max={100}
            value={x}
            disabled={!canEdit}
            onChange={(event) => setX(Number(event.target.value))}
            className="mt-1 w-full"
          />
        </label>
        <label className="text-sm">
          Move Up / Down
          <input
            type="range"
            min={0}
            max={100}
            value={y}
            disabled={!canEdit}
            onChange={(event) => setY(Number(event.target.value))}
            className="mt-1 w-full"
          />
        </label>
      </div>

      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept={PUBLIC_SITE_IMAGE_FILE_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              data-website-photo-file-input={`${slot.page}:${slot.slot}`}
              onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={openPhotoChooser}
            >
              Choose Photo
            </Button>
            <Button
              type="button"
              disabled={!canReplace}
              onClick={submitReplacement}
            >
              {replacePending ? "Uploading…" : "Replace Image"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {selectedFile
                ? `Selected: ${selectedFile.name}`
                : "No photo selected"}
            </p>
            <p className="basis-full text-xs text-muted-foreground">
              JPEG, PNG, or WebP, up to 4 MB. Photos upload only when you click
              Replace Image.
            </p>
          </div>
          <form action={positionAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="page" value={slot.page} />
            <input type="hidden" name="slot" value={slot.slot} />
            <input type="hidden" name="currentSrc" value={slot.src} />
            <input type="hidden" name="positionX" value={String(x)} />
            <input type="hidden" name="positionY" value={String(y)} />
            <input type="hidden" name="objectZoom" value={String(zoom)} />
            <Button type="submit" variant="outline" disabled={pending || !unsaved}>
              {positionPending ? "Saving…" : "Save Changes"}
            </Button>
          </form>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={resetCropLocally}
          >
            Reset
          </Button>
          <form action={resetAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="page" value={slot.page} />
            <input type="hidden" name="slot" value={slot.slot} />
            <Button type="submit" variant="ghost" disabled={pending || !slot.isOverride}>
              {resetPending ? "Resetting…" : "Restore default photo"}
            </Button>
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Viewing only. Replacing website photos requires owner or admin access.
        </p>
      )}
    </div>
  );
}

function ServiceCategoryPicker({
  slots,
  businessId,
  storageConfigured,
  storageUsage,
  canEdit,
}: {
  slots: PublicSiteImageEditorSlot[];
  businessId: string;
  storageConfigured: boolean;
  storageUsage?: { usedBytes: number; limitBytes: number } | null;
  canEdit: boolean;
}) {
  const [openSlot, setOpenSlot] = useState(slots[0]?.slot ?? "");
  const selected = slots.find((slot) => slot.slot === openSlot) ?? slots[0];

  if (slots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No service-category photo slots are available yet. Category photos stay linked
        to the real catalog.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {slots.map((slot) => (
          <button
            key={`${slot.page}:${slot.slot}`}
            type="button"
            onClick={() => setOpenSlot(slot.slot)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm",
              selected?.slot === slot.slot
                ? "border-primary bg-primary/10 font-medium"
                : "bg-background text-muted-foreground",
            )}
          >
            {slot.category ?? slot.label}
          </button>
        ))}
      </div>
      {selected ? (
        <SlotEditor
          key={`${selected.page}:${selected.slot}`}
          slot={selected}
          heading={selected.category ?? selected.label}
          businessId={businessId}
          storageConfigured={storageConfigured}
          storageUsage={storageUsage}
          canEdit={canEdit}
        />
      ) : null}
    </div>
  );
}

export function WebsitePhotosEditor({
  businessId,
  slots,
  storageConfigured,
  storageUsage,
  canEdit,
}: {
  businessId: string;
  slots: PublicSiteImageEditorSlot[];
  storageConfigured: boolean;
  storageUsage?: { usedBytes: number; limitBytes: number } | null;
  canEdit: boolean;
}) {
  const homeHero = slots.find((slot) => slot.page === "home" && slot.kind === "hero");
  const homeCategories = slots.filter(
    (slot) => slot.page === "home" && slot.kind === "category",
  );
  const servicesHero = slots.find(
    (slot) => slot.page === "services" && slot.kind === "hero",
  );
  const servicesCategories = slots.filter(
    (slot) => slot.page === "services" && slot.kind === "category",
  );
  const aboutSlots = slots.filter((slot) => slot.page === "about");
  const reviewsSlots = slots.filter((slot) => slot.page === "reviews");
  const otherHeroes = useMemo(
    () => [servicesHero, ...aboutSlots, ...reviewsSlots].filter(Boolean) as PublicSiteImageEditorSlot[],
    [aboutSlots, reviewsSlots, servicesHero],
  );

  return (
    <div className="space-y-8">
      {!storageConfigured ? (
        <Alert>
          <AlertDescription>{PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE}</AlertDescription>
        </Alert>
      ) : null}
      {storageUsage ? (
        <p className="text-sm text-muted-foreground">
          Storage {formatStorageBytes(storageUsage.usedBytes)} used of{" "}
          {formatStorageBytes(storageUsage.limitBytes)}. This business has a
          defined storage amount — it is not unlimited.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Adjust how each website photo fits its slot. The original upload is kept.
        Page layout, fonts, colors, service names, and Recent Projects stay as they
        are. Recent Projects come from real completed work and cannot be replaced here.
      </p>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">Home Hero</h3>
        {homeHero ? (
          <SlotEditor
            slot={homeHero}
            heading="Home Hero"
            businessId={businessId}
            storageConfigured={storageConfigured}
            storageUsage={storageUsage}
            canEdit={canEdit}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No Home hero slot is available.</p>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">Service Categories</h3>
        <p className="text-sm text-muted-foreground">
          Each card has its own crop. Changing one category does not change the Home
          Hero or another card, even if they use the same source photo.
        </p>
        <ServiceCategoryPicker
          slots={homeCategories}
          businessId={businessId}
          storageConfigured={storageConfigured}
          storageUsage={storageUsage}
          canEdit={canEdit}
        />
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">Other website photos</h3>
        {otherHeroes.map((slot) => (
          <SlotEditor
            key={`${slot.page}:${slot.slot}`}
            slot={slot}
            businessId={businessId}
            storageConfigured={storageConfigured}
            storageUsage={storageUsage}
            canEdit={canEdit}
          />
        ))}
        {servicesCategories.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Services page categories</h4>
            <ServiceCategoryPicker
              slots={servicesCategories}
              businessId={businessId}
              storageConfigured={storageConfigured}
              storageUsage={storageUsage}
              canEdit={canEdit}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
