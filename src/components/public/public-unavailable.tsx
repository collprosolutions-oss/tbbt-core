export function PublicUnavailable({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <main className="public-site mx-auto flex min-h-full max-w-md items-center px-4 py-16">
      <div className="rounded-xl border border-border bg-white p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </div>
    </main>
  );
}
