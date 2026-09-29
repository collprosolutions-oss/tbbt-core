"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { WritingAssistBar } from "@/components/ai/writing-assist-bar";
import {
  addWebsiteGalleryItemAction,
  publishWebsiteAction,
  removeWebsiteGalleryItemAction,
  restoreWebsiteAction,
  saveWebsiteLocalPageDraftAction,
  saveWebsiteSeoDraftAction,
  setReviewWebsiteSelectedAction,
  type WebsiteEngineActionState,
} from "@/app/actions/website-engine";
import {
  WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED,
  WEBSITE_PUBLISH_RESTORE_DESCRIPTION,
} from "@/lib/website-engine/snapshot";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ViewPublicWebsiteLink } from "@/components/settings/view-public-website-link";

const initial: WebsiteEngineActionState = {};

function newAttemptKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function useFormAttemptKey(successToken?: string) {
  const [key, setKey] = useState(newAttemptKey);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (successToken && successToken !== seen.current) {
      seen.current = successToken;
      setKey(newAttemptKey());
    }
  }, [successToken]);
  return key;
}

export function WebsitePublishPanel({
  slug,
  canEdit,
  canRestore,
  hasUnpublishedChanges,
  currentId,
  historyLimit,
  currentVersion,
  versions,
  reviews,
  galleryAssets,
  galleryItems,
  localPairs,
  seo,
}: {
  slug: string;
  canEdit: boolean;
  canRestore: boolean;
  hasUnpublishedChanges: boolean;
  currentId: string | null;
  historyLimit: number;
  currentVersion: number | null;
  versions: Array<{
    id: string;
    versionNumber: number;
    publishedAt: string;
    summary: string;
    sourcePublishId: string | null;
    isCurrent: boolean;
    publishedByName: string | null;
  }>;
  reviews: Array<{ id: string; reviewText: string; websiteSelected: boolean }>;
  galleryAssets: Array<{ id: string; publicPath: string | null }>;
  galleryItems: Array<{ id: string; title: string; caption: string; imageUrl: string | null }>;
  localPairs: Array<{ serviceAreaId: string; catalogItemId: string; label: string; draftCopy: string }>;
  seo: {
    websiteHeroHeadline: string;
    websiteHeroSupporting: string;
    seoTitleHome: string;
    seoDescriptionHome: string;
    seoTitleServices: string;
    seoDescriptionServices: string;
    seoTitleAbout: string;
    seoDescriptionAbout: string;
    seoTitleRequest: string;
    seoDescriptionRequest: string;
  };
}) {
  const [publishState, publishAction, publishing] = useActionState(publishWebsiteAction, initial);
  const [restoreState, restoreAction, restoring] = useActionState(restoreWebsiteAction, initial);
  const [seoState, seoAction, savingSeo] = useActionState(saveWebsiteSeoDraftAction, initial);
  const [galleryState, galleryAction, addingGallery] = useActionState(addWebsiteGalleryItemAction, initial);
  const [localState, localAction, savingLocal] = useActionState(saveWebsiteLocalPageDraftAction, initial);
  const [heroHeadline, setHeroHeadline] = useState(seo.websiteHeroHeadline);
  const [heroSupporting, setHeroSupporting] = useState(seo.websiteHeroSupporting);
  const [seoHomeDescription, setSeoHomeDescription] = useState(seo.seoDescriptionHome);
  const [localPairKey, setLocalPairKey] = useState(
    localPairs[0] ? `${localPairs[0].serviceAreaId}:${localPairs[0].catalogItemId}` : "",
  );
  const selectedLocalPair =
    localPairs.find((pair) => `${pair.serviceAreaId}:${pair.catalogItemId}` === localPairKey) ??
    localPairs[0];
  const [localCopy, setLocalCopy] = useState(selectedLocalPair?.draftCopy ?? "");
  const publishKey = useFormAttemptKey(publishState.message);

  return (
    <div className="space-y-6">
      <ViewPublicWebsiteLink slug={slug} className="mb-2" />
      <p className="text-sm text-muted-foreground">
        {currentVersion
          ? `Current published version: ${currentVersion}.`
          : "This site still uses the live compatibility path until the first publish."}{" "}
        Publishing captures the current intake snapshot for each trade. The live site keeps those exact versions until you publish or restore.{" "}
        {hasUnpublishedChanges ? "There are unpublished draft changes." : "Draft matches the current publish."}
      </p>
      <p className="text-sm text-muted-foreground">{WEBSITE_PUBLISH_RESTORE_DESCRIPTION}</p>
      {publishState.error || restoreState.error || seoState.error || galleryState.error || localState.error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {publishState.error || restoreState.error || seoState.error || galleryState.error || localState.error}
          </AlertDescription>
        </Alert>
      ) : null}
      {publishState.message || restoreState.message || seoState.message ? (
        <p className="text-sm">{publishState.message || restoreState.message || seoState.message}</p>
      ) : null}

      {canEdit ? (
        <form action={publishAction}>
          <input type="hidden" name="idempotencyKey" value={publishKey} />
          <Button type="submit" disabled={publishing}>
            {publishing ? "Publishing…" : "Publish website"}
          </Button>
        </form>
      ) : null}

      {canEdit ? (
        <form action={seoAction} className="space-y-3">
          <Label>Homepage headline</Label>
          <Input
            name="websiteHeroHeadline"
            value={heroHeadline}
            onChange={(event) => setHeroHeadline(event.target.value)}
          />
          <WritingAssistBar
            original={heroHeadline}
            context="Homepage hero headline. Do not invent licenses, years, ratings, prices, or guarantees."
            onSuggestion={setHeroHeadline}
          />
          <Label>Homepage supporting copy</Label>
          <textarea
            name="websiteHeroSupporting"
            value={heroSupporting}
            onChange={(event) => setHeroSupporting(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-input px-2.5 py-1.5 text-sm"
          />
          <WritingAssistBar
            original={heroSupporting}
            context="Homepage supporting copy. Do not invent licenses, years, ratings, prices, service areas, or guarantees."
            onSuggestion={setHeroSupporting}
          />
          <Label>SEO home title</Label>
          <Input name="seoTitleHome" defaultValue={seo.seoTitleHome} />
          <Label>SEO home description</Label>
          <textarea
            name="seoDescriptionHome"
            value={seoHomeDescription}
            onChange={(event) => setSeoHomeDescription(event.target.value)}
            rows={2}
            className="w-full rounded-lg border border-input px-2.5 py-1.5 text-sm"
          />
          <WritingAssistBar
            original={seoHomeDescription}
            context="SEO meta description. Do not invent licenses, ratings, reviews, prices, or guarantees."
            onSuggestion={setSeoHomeDescription}
          />
          <Input name="seoTitleServices" defaultValue={seo.seoTitleServices} placeholder="Services title" />
          <Input name="seoDescriptionServices" defaultValue={seo.seoDescriptionServices} placeholder="Services description" />
          <Input name="seoTitleAbout" defaultValue={seo.seoTitleAbout} placeholder="About title" />
          <Input name="seoDescriptionAbout" defaultValue={seo.seoDescriptionAbout} placeholder="About description" />
          <Input name="seoTitleRequest" defaultValue={seo.seoTitleRequest} placeholder="Request title" />
          <Input name="seoDescriptionRequest" defaultValue={seo.seoDescriptionRequest} placeholder="Request description" />
          <Button type="submit" variant="outline" disabled={savingSeo}>
            {savingSeo ? "Saving…" : "Save website copy"}
          </Button>
        </form>
      ) : null}

      <div>
        <h3 className="font-medium">Public reviews</h3>
        <p className="text-sm text-muted-foreground">Original customer text is preserved. Selection only controls the next publish.</p>
        <ul className="mt-2 space-y-2">
          {reviews.map((review) => (
            <li key={review.id} className="text-sm">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  defaultChecked={review.websiteSelected}
                  disabled={!canEdit}
                  onChange={(event) => {
                    void setReviewWebsiteSelectedAction(review.id, event.target.checked);
                  }}
                />
                <span>{review.reviewText}</span>
              </label>
            </li>
          ))}
          {reviews.length === 0 ? <li className="text-sm text-muted-foreground">No recorded reviews yet.</li> : null}
        </ul>
      </div>

      {canEdit ? (
        <div className="space-y-3">
          <div>
            <h3 className="font-medium">Gallery draft</h3>
            <ul className="mt-2 space-y-2">
              {galleryItems.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                  <span>
                    {item.title || "Gallery photo"}
                    {item.caption ? ` — ${item.caption}` : ""}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void removeWebsiteGalleryItemAction(item.id);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
              {galleryItems.length === 0 ? (
                <li className="text-sm text-muted-foreground">No gallery photos in the next publish yet.</li>
              ) : null}
            </ul>
          </div>
          <form action={galleryAction} className="space-y-2">
            <h3 className="font-medium">Add gallery photo</h3>
            <Label>Public website asset ID</Label>
            <select name="storedAssetId" className="h-8 w-full rounded-lg border border-input px-2.5 text-sm">
              {galleryAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.id}
                </option>
              ))}
            </select>
            <Input name="title" placeholder="Title" />
            <Input name="caption" placeholder="Caption" />
            <Button type="submit" variant="outline" disabled={addingGallery || galleryAssets.length === 0}>
              Add to gallery draft
            </Button>
          </form>
        </div>
      ) : null}

      {canEdit && localPairs.length > 0 ? (
        <form action={localAction} className="space-y-2">
          <h3 className="font-medium">Local page draft</h3>
          <select
            name="pair"
            className="h-8 w-full rounded-lg border border-input px-2.5 text-sm"
            id="local-pair"
            value={localPairKey}
            onChange={(event) => {
              const next = event.target.value;
              setLocalPairKey(next);
              const pair = localPairs.find(
                (row) => `${row.serviceAreaId}:${row.catalogItemId}` === next,
              );
              setLocalCopy(pair?.draftCopy ?? "");
            }}
          >
            {localPairs.map((pair) => (
              <option key={`${pair.serviceAreaId}:${pair.catalogItemId}`} value={`${pair.serviceAreaId}:${pair.catalogItemId}`}>
                {pair.label}
              </option>
            ))}
          </select>
          <textarea
            name="draftCopy"
            value={localCopy}
            onChange={(event) => setLocalCopy(event.target.value)}
            rows={4}
            className="w-full rounded-lg border border-input px-2.5 py-1.5 text-sm"
          />
          <WritingAssistBar
            original={localCopy}
            context="Local service-area page draft. Use only the named city and service. Do not invent licenses, ratings, prices, or other cities."
            onSuggestion={setLocalCopy}
          />
          <Button type="submit" variant="outline" disabled={savingLocal}>
            Save local draft
          </Button>
        </form>
      ) : null}

      <div>
        <h3 className="font-medium">Version history</h3>
        <ul className="mt-2 space-y-2 text-sm">
          {versions.map((version) => (
            <li key={version.id} className="rounded-md border p-2">
              <p>
                Version {version.versionNumber}
                {version.isCurrent ? " · current" : ""}
                {version.sourcePublishId ? " · rollback" : ""}
              </p>
              <p className="text-muted-foreground">
                {new Date(version.publishedAt).toLocaleString()} · {version.publishedByName || "Unknown"} · {version.summary}
              </p>
              {canRestore && currentId && !version.isCurrent ? (
                <form action={restoreAction} className="mt-2 space-y-2">
                  <input type="hidden" name="publishId" value={version.id} />
                  <input type="hidden" name="expectedCurrentId" value={currentId} />
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="confirmed" value="1" className="mt-1" />
                    <span>{WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED}</span>
                  </label>
                  <Button type="submit" size="sm" variant="outline" disabled={restoring}>
                    {restoring ? "Restoring…" : "Restore this version as current"}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
          {versions.length === 0 ? <li>No published versions yet.</li> : null}
        </ul>
        {versions.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the newest {historyLimit} published website versions. Restore moves the current
            public site and the exact captured intake versions. Historical requests stay unchanged.
          </p>
        ) : null}
        {canEdit && !canRestore ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Only the owner can restore a prior published website.
          </p>
        ) : null}
      </div>
    </div>
  );
}
