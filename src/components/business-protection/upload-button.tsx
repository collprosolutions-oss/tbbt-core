"use client";

import { useState } from "react";
import {
  abortVaultDocumentUploadAction,
  authorizeVaultDocumentUploadAction,
  finalizeVaultDocumentUploadAction,
} from "@/app/actions/business-protection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function VaultUploadButton({
  name = "storedAssetId",
  defaultAssetId,
}: {
  name?: string;
  defaultAssetId?: string;
}) {
  const [assetId, setAssetId] = useState(defaultAssetId ?? "");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || pending) return;
    setPending(true);
    setStatus("Authorizing private upload…");
    let createdId = "";
    try {
      const authorized = await authorizeVaultDocumentUploadAction({
        originalFilename: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSizeBytes: file.size,
      });
      if (authorized.error || !authorized.assetId || !authorized.uploadUrl) {
        setStatus(authorized.error || "That file could not be authorized.");
        return;
      }
      createdId = authorized.assetId;
      const uploaded = await fetch(authorized.uploadUrl, {
        method: authorized.uploadMethod || "PUT",
        headers: authorized.uploadHeaders,
        body: file,
      });
      if (!uploaded.ok) {
        await abortVaultDocumentUploadAction({ assetId: createdId });
        setStatus("The file could not be uploaded to private storage.");
        return;
      }
      const finalized = await finalizeVaultDocumentUploadAction({ assetId: createdId });
      if (finalized.error || !finalized.assetId) {
        setStatus(finalized.error || "That vault file could not be saved.");
        return;
      }
      setAssetId(finalized.assetId);
      setStatus("Private file stored. It was not published.");
    } catch {
      if (createdId) await abortVaultDocumentUploadAction({ assetId: createdId });
      setStatus("The vault upload failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${name}-file`}>Private file</Label>
      <Input
        id={`${name}-file`}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.txt,application/pdf"
        disabled={pending}
        onChange={onChange}
      />
      <input type="hidden" name={name} value={assetId} />
      {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      {assetId ? (
        <p className="text-xs">
          Stored privately. <Button type="button" variant="ghost" size="sm" onClick={() => setAssetId("")}>Remove attachment</Button>
        </p>
      ) : null}
    </div>
  );
}
