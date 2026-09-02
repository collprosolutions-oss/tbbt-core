"use client";

import { useActionState, useState, type MouseEvent } from "react";
import {
  replacePublicSiteImage,
  repositionPublicSiteImage,
  resetPublicSiteImage,
  type PublicSiteImageActionState,
} from "@/app/actions/public-site-images";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE,
  splitObjectPosition,
  type PublicSiteImageEditorSlot,
} from "@/lib/public-site-images";

const emptyState: PublicSiteImageActionState = {};

function SlotEditor({
  slot,
  businessId,
  storageConfigured,
  canEdit,
}: {
  slot: PublicSiteImageEditorSlot;
  businessId: string;
  storageConfigured: boolean;
  canEdit: boolean;
}) {
  const start = splitObjectPosition(slot.objectPosition);
  const [x, setX] = useState(start.x);
  const [y, setY] = useState(start.y);
  const [replaceState, replaceAction, replacePending] = useActionState(
    replacePublicSiteImage,
    emptyState,
  );
  const [positionState, positionAction, positionPending] = useActionState(
    repositionPublicSiteImage,
    emptyState,
  );
  const [resetState, resetAction, resetPending] = useActionState(
    resetPublicSiteImage,
    emptyState,
  );
  const pending = replacePending || positionPending || resetPending;
  const error = replaceState.error || positionState.error || resetState.error;
  const message = replaceState.message || positionState.message || resetState.message;

  function setFromPreview(event: MouseEvent<HTMLButtonElement>) {
    if (!canEdit) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextX = Math.round(((event.clientX - rect.left) / rect.width) * 100);
    const nextY = Math.round(((event.clientY - rect.top) / rect.height) * 100);
    setX(Math.min(100, Math.max(0, nextX)));
    setY(Math.min(100, Math.max(0, nextY)));
  }

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{slot.label}</p>
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
                      : "Home hero photograph. Layout stays the same."
                : slot.page === "services"
                  ? "Services category photograph only. The category name and services do not change."
                  : "Home category card photograph only. The category name and services do not change."}
          </p>
        </div>
        {slot.isOverride ? (
          <p className="text-xs font-medium text-primary">Custom photo</p>
        ) : (
          <p className="text-xs text-muted-foreground">Default photo</p>
        )}
      </div>

      <button
        type="button"
        onClick={setFromPreview}
        className="relative block aspect-[16/9] w-full overflow-hidden rounded-lg border bg-muted"
        aria-label={`Preview ${slot.label}. Click to set the focal point.`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={slot.src}
          alt=""
          className="absolute inset-0 size-full object-cover"
          style={{ objectPosition: `${x}% ${y}%` }}
        />
      </button>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Horizontal
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
          Vertical
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
          <form action={replaceAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="page" value={slot.page} />
            <input type="hidden" name="slot" value={slot.slot} />
            <input
              type="file"
              name="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif"
              disabled={!storageConfigured || pending}
              className="max-w-[16rem] text-sm"
            />
            <Button type="submit" disabled={!storageConfigured || pending}>
              {replacePending ? "Uploading…" : "Replace Image"}
            </Button>
          </form>
          <form action={positionAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="page" value={slot.page} />
            <input type="hidden" name="slot" value={slot.slot} />
            <input type="hidden" name="currentSrc" value={slot.src} />
            <input type="hidden" name="positionX" value={String(x)} />
            <input type="hidden" name="positionY" value={String(y)} />
            <Button type="submit" variant="outline" disabled={pending}>
              {positionPending ? "Saving…" : "Save Position"}
            </Button>
          </form>
          <form action={resetAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="page" value={slot.page} />
            <input type="hidden" name="slot" value={slot.slot} />
            <Button type="submit" variant="ghost" disabled={pending || !slot.isOverride}>
              {resetPending ? "Resetting…" : "Reset to Default"}
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

export function WebsitePhotosEditor({
  businessId,
  slots,
  storageConfigured,
  canEdit,
}: {
  businessId: string;
  slots: PublicSiteImageEditorSlot[];
  storageConfigured: boolean;
  canEdit: boolean;
}) {
  const homeSlots = slots.filter((slot) => slot.page === "home");
  const servicesSlots = slots.filter((slot) => slot.page === "services");
  const aboutSlots = slots.filter((slot) => slot.page === "about");

  return (
    <div className="space-y-6">
      {!storageConfigured ? (
        <Alert>
          <AlertDescription>{PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Change Home, Services, and About marketing photos. Page layout, fonts, colors, and
        Recent Projects stay as they are. Recent Projects come from real completed
        work and cannot be replaced here.
      </p>
      <PhotoPageSection
        title="Home page"
        empty="No Home photo slots are available."
        slots={homeSlots}
        businessId={businessId}
        storageConfigured={storageConfigured}
        canEdit={canEdit}
      />
      <PhotoPageSection
        title="Services page"
        empty="No Services photo slots are available yet. Category photos stay linked to the real catalog."
        slots={servicesSlots}
        businessId={businessId}
        storageConfigured={storageConfigured}
        canEdit={canEdit}
      />
      <PhotoPageSection
        title="About page"
        empty="No About photo slots are available."
        slots={aboutSlots}
        businessId={businessId}
        storageConfigured={storageConfigured}
        canEdit={canEdit}
      />
    </div>
  );
}

function PhotoPageSection({
  title,
  empty,
  slots,
  businessId,
  storageConfigured,
  canEdit,
}: {
  title: string;
  empty: string;
  slots: PublicSiteImageEditorSlot[];
  businessId: string;
  storageConfigured: boolean;
  canEdit: boolean;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold">{title}</h3>
      {slots.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        slots.map((slot) => (
          <SlotEditor
            key={`${slot.page}:${slot.slot}`}
            slot={slot}
            businessId={businessId}
            storageConfigured={storageConfigured}
            canEdit={canEdit}
          />
        ))
      )}
    </section>
  );
}
