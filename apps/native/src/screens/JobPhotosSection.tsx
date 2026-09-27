import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  abortNativeJobPhoto,
  authorizeNativeJobPhoto,
  finalizeNativeJobPhoto,
  isApiError,
} from "../api";
import { inspectNativeJobPhoto, nativeJobPhotoMaxBytesLabel } from "../photo-rules";
import type { NativeJobPhoto, NativeJobPhotos, NativeJobPhotoStage, NativeJobDetail } from "../types";

type PhotoDraft = {
  uri: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  stage: NativeJobPhotoStage;
  caption: string;
};

const STAGES: Array<{ value: NativeJobPhotoStage; label: string }> = [
  { value: "BEFORE", label: "Before" },
  { value: "DURING", label: "During" },
  { value: "AFTER", label: "After" },
];

function stageTitle(stage: NativeJobPhotoStage) {
  return STAGES.find((item) => item.value === stage)?.label ?? stage;
}

export function JobPhotosSection({
  token,
  jobId,
  photos,
  onJobUpdated,
}: {
  token: string;
  jobId: string;
  photos: NativeJobPhotos;
  onJobUpdated: (job: NativeJobDetail) => void;
}) {
  const [draft, setDraft] = useState<PhotoDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function openCapturedAsset(asset: ImagePicker.ImagePickerAsset) {
    let size = asset.fileSize ?? 0;
    if (size <= 0) {
      try {
        const response = await fetch(asset.uri);
        const blob = await response.blob();
        size = blob.size;
      } catch {
        size = 0;
      }
    }
    const inspected = inspectNativeJobPhoto({
      type: asset.mimeType,
      name: asset.fileName ?? "photo.jpg",
      size,
    });
    if (!inspected.ok) {
      setError(inspected.error);
      setDraft(null);
      return;
    }
    setError(null);
    setDraft({
      uri: asset.uri,
      fileName: inspected.fileName,
      mimeType: inspected.mimeType,
      fileSizeBytes: inspected.fileSizeBytes,
      stage: "BEFORE",
      caption: "",
    });
  }

  async function takePhoto() {
    if (pending) return;
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError("Camera access is required to take a job photo.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      exif: false,
    });
    if (result.canceled || !result.assets[0]) return;
    await openCapturedAsset(result.assets[0]);
  }

  async function choosePhoto() {
    if (pending) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Photo library access is required to choose a job photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      exif: false,
    });
    if (result.canceled || !result.assets[0]) return;
    await openCapturedAsset(result.assets[0]);
  }

  async function uploadDraft() {
    if (!draft || pending) return;
    const inspected = inspectNativeJobPhoto({
      type: draft.mimeType,
      name: draft.fileName,
      size: draft.fileSizeBytes,
    });
    if (!inspected.ok) {
      setError(inspected.error);
      return;
    }

    setPending(true);
    setError(null);
    let assetId = "";
    try {
      const authorized = await authorizeNativeJobPhoto(token, jobId, {
        originalFilename: inspected.fileName,
        mimeType: inspected.mimeType,
        fileSizeBytes: inspected.fileSizeBytes,
      });
      if (isApiError(authorized)) {
        setError(authorized.error);
        return;
      }
      assetId = authorized.assetId;

      const body = await fetch(draft.uri);
      const uploaded = await fetch(authorized.uploadUrl, {
        method: authorized.uploadMethod || "PUT",
        headers: authorized.uploadHeaders,
        body: await body.blob(),
      });
      if (!uploaded.ok) {
        await abortNativeJobPhoto(token, jobId, assetId);
        setError("The photo could not be uploaded to file storage. Try again.");
        return;
      }

      const finalized = await finalizeNativeJobPhoto(token, jobId, {
        assetId,
        stage: draft.stage,
        caption: draft.caption,
      });
      if (isApiError(finalized)) {
        await abortNativeJobPhoto(token, jobId, assetId);
        setError(finalized.error);
        return;
      }
      setDraft(null);
      onJobUpdated(finalized.job);
    } catch {
      if (assetId) {
        await abortNativeJobPhoto(token, jobId, assetId);
      }
      setError("That photo could not be uploaded. Try again.");
    } finally {
      setPending(false);
    }
  }

  const byStage: Record<NativeJobPhotoStage, NativeJobPhoto[]> = {
    BEFORE: [],
    DURING: [],
    AFTER: [],
  };
  for (const photo of photos.items) {
    byStage[photo.stage].push(photo);
  }

  return (
    <View style={styles.section}>
      <Text style={styles.groupTitle}>Job photos</Text>
      <Text style={styles.meta}>
        {photos.count} of {photos.limit} · Private to the business · Up to{" "}
        {nativeJobPhotoMaxBytesLabel()}
      </Text>
      {photos.truncatedNotice ? <Text style={styles.notice}>{photos.truncatedNotice}</Text> : null}

      {draft ? (
        <View style={styles.review}>
          <Text style={styles.reviewTitle}>Review photo</Text>
          <Image source={{ uri: draft.uri }} style={styles.preview} />
          <Text style={styles.meta}>
            {draft.fileName} · {Math.ceil(draft.fileSizeBytes / 1024)} KB
          </Text>
          <View style={styles.stages}>
            {STAGES.map((stage) => (
              <Pressable
                key={stage.value}
                disabled={pending}
                onPress={() => setDraft({ ...draft, stage: stage.value })}
                style={[
                  styles.stage,
                  draft.stage === stage.value ? styles.stageActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.stageLabel,
                    draft.stage === stage.value ? styles.stageLabelActive : null,
                  ]}
                >
                  {stage.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            editable={!pending}
            onChangeText={(caption) => setDraft({ ...draft, caption })}
            placeholder="Caption (optional)"
            placeholderTextColor="#9ca3af"
            style={styles.caption}
            value={draft.caption}
          />
          <Pressable
            disabled={pending}
            onPress={() => {
              void uploadDraft();
            }}
            style={[styles.primaryAction, pending ? styles.disabled : null]}
          >
            <Text style={styles.primaryActionLabel}>{pending ? "Uploading…" : "Upload photo"}</Text>
          </Pressable>
          <View style={styles.actions}>
            <Pressable
              disabled={pending}
              onPress={() => {
                void takePhoto();
              }}
              style={styles.action}
            >
              <Text style={styles.actionLabel}>Retake</Text>
            </Pressable>
            <Pressable
              disabled={pending}
              onPress={() => {
                setDraft(null);
                setError(null);
              }}
              style={styles.action}
            >
              <Text style={styles.actionLabel}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : photos.upload.available ? (
        <View style={styles.actions}>
          <Pressable
            disabled={pending}
            onPress={() => {
              void takePhoto();
            }}
            style={styles.primaryAction}
          >
            <Text style={styles.primaryActionLabel}>Take photo</Text>
          </Pressable>
          <Pressable
            disabled={pending}
            onPress={() => {
              void choosePhoto();
            }}
            style={styles.action}
          >
            <Text style={styles.actionLabel}>Choose photo</Text>
          </Pressable>
        </View>
      ) : photos.upload.reason ? (
        <Text style={styles.notice}>{photos.upload.reason}</Text>
      ) : null}

      {pending && !draft ? <ActivityIndicator color="#86efac" /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {STAGES.map((stage) => (
        <PhotoGroup key={stage.value} title={stage.label} photos={byStage[stage.value]} />
      ))}
    </View>
  );
}

function PhotoGroup({ title, photos }: { title: string; photos: NativeJobPhoto[] }) {
  return (
    <View style={styles.group}>
      <Text style={styles.subTitle}>
        {title} ({photos.length})
      </Text>
      {photos.length === 0 ? (
        <Text style={styles.body}>No {title.toLowerCase()} photos yet.</Text>
      ) : (
        photos.map((photo) => (
          <View key={photo.id} style={styles.photo}>
            {photo.previewUrl ? (
              <Image source={{ uri: photo.previewUrl }} style={styles.thumb} />
            ) : (
              <View style={styles.thumbMissing}>
                <Text style={styles.meta}>Preview unavailable</Text>
              </View>
            )}
            <Text style={styles.body}>
              {photo.caption || `${stageTitle(photo.stage)} photo`}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 10,
    marginTop: 8,
  },
  groupTitle: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginTop: 12,
    textTransform: "uppercase",
  },
  subTitle: {
    color: "#d1d5db",
    fontWeight: "700",
  },
  meta: {
    color: "#d1d5db",
    fontSize: 15,
  },
  body: {
    color: "#e5e7eb",
    fontSize: 15,
    lineHeight: 22,
  },
  notice: {
    color: "#fbbf24",
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    color: "#fca5a5",
  },
  review: {
    gap: 10,
    backgroundColor: "#1f2937",
    borderRadius: 12,
    padding: 12,
  },
  reviewTitle: {
    color: "#f9fafb",
    fontWeight: "700",
    fontSize: 16,
  },
  preview: {
    width: "100%",
    height: 220,
    borderRadius: 12,
    backgroundColor: "#111827",
  },
  stages: {
    flexDirection: "row",
    gap: 8,
  },
  stage: {
    flex: 1,
    alignItems: "center",
    borderRadius: 10,
    paddingVertical: 10,
    backgroundColor: "#111827",
  },
  stageActive: {
    backgroundColor: "#166534",
  },
  stageLabel: {
    color: "#d1d5db",
    fontWeight: "600",
  },
  stageLabelActive: {
    color: "#f9fafb",
  },
  caption: {
    backgroundColor: "#111827",
    borderRadius: 10,
    color: "#f9fafb",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  action: {
    backgroundColor: "#1f2937",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: "center",
  },
  actionLabel: {
    color: "#f9fafb",
    fontWeight: "600",
  },
  primaryAction: {
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: "center",
    flex: 1,
  },
  primaryActionLabel: {
    color: "#f9fafb",
    fontWeight: "700",
    fontSize: 16,
  },
  disabled: {
    opacity: 0.6,
  },
  group: {
    gap: 8,
  },
  photo: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    backgroundColor: "#1f2937",
  },
  thumbMissing: {
    width: 72,
    height: 72,
    borderRadius: 10,
    backgroundColor: "#1f2937",
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
  },
});
