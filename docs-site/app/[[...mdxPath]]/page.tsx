import { notFound } from "next/navigation";
import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents } from "../../mdx-components";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  try {
    const { metadata } = await importPage(params.mdxPath);
    return metadata;
  } catch {
    return { title: "Not Found" };
  }
}

type PageProps = {
  params: Promise<{ mdxPath?: string[] }>;
};

export default async function Page(props: PageProps) {
  const params = await props.params;

  let result: Awaited<ReturnType<typeof importPage>>;
  try {
    result = await importPage(params.mdxPath);
  } catch {
    notFound();
  }

  const { default: MDXContent, ...rest } = result;
  const Wrapper = useMDXComponents().wrapper;

  // `content` is a symlink to `../docs`, so Nextra reports filePath as
  // `content/<page>.md` while git only knows the file as `docs/<page>.md`.
  // The theme builds "Edit this page" as docsRepositoryBase + filePath, so the
  // symlink segment has to come off here or every link 404s on GitHub.
  const metadata = { ...rest.metadata };
  if (typeof metadata.filePath === "string") {
    metadata.filePath = metadata.filePath.replace(/^content\//, "");
  }

  return (
    <Wrapper {...rest} metadata={metadata}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
