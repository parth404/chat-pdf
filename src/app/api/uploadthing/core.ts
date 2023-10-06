import { db } from "@/db";
import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { createUploadthing, type FileRouter } from "uploadthing/next";

import { PDFLoader } from "langchain/document_loaders/fs/pdf";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { PineconeStore } from "langchain/vectorstores/pinecone";
import { getPineconeClient } from "@/lib/pinecone";
import { getUserSubscriptionPlan } from "@/lib/stripe";
import { PLANS } from "@/config/stripe";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

const f = createUploadthing();

const middleware = async () => {
  const { getUser } = getKindeServerSession();
  const user = getUser();

  if (!user || !user.id) throw new Error("Unauthorized");

  const subscriptionPlan = await getUserSubscriptionPlan();

  return { subscriptionPlan, userId: user.id };
};

const onUploadComplete = async ({
  metadata,
  file,
}: {
  metadata: Awaited<ReturnType<typeof middleware>>;
  file: {
    key: string;
    name: string;
    url: string;
  };
}) => {
  const isFileExist = await db.file.findFirst({
    where: {
      key: file.key,
    },
  });

  if (isFileExist) return;

  const createdFile = await db.file.create({
    data: {
      key: file.key,
      name: file.name,
      userId: metadata.userId,
      url: `https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`,
      uploadStatus: "PROCESSING",
    },
  });

  try {
    const response = await fetch(
      `https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`
    );

    const blob = await response.blob();
    console.log("blob", blob);
    const loader = new PDFLoader(blob);

    const pageLevelDocs = await loader.load();
    console.log("pageLevelDocs", pageLevelDocs);
    const pagesAmt = pageLevelDocs.length;

    const { subscriptionPlan } = metadata;
    const { isSubscribed } = subscriptionPlan;

    const isProExceeded =
      pagesAmt > PLANS.find((plan) => plan.name === "Pro")!.pagesPerPdf;
    const isFreeExceeded =
      pagesAmt > PLANS.find((plan) => plan.name === "Free")!.pagesPerPdf;

    if ((isSubscribed && isProExceeded) || (!isSubscribed && isFreeExceeded)) {
      await db.file.update({
        data: {
          uploadStatus: "FAILED",
        },
        where: {
          id: createdFile.id,
        },
      });
    }

    // vectorize and index entire document
    const pinecone = await getPineconeClient();
    const pineconeIndex = pinecone.Index("parthsbot");

    // // 5. Process each document in the docs array
    // for (const doc of pageLevelDocs) {
    //   console.log(`Processing document: ${doc.metadata.source}`);
    //   const txtPath = doc.metadata.source;
    //   const text = doc.pageContent;
    //   // 6. Create RecursiveCharacterTextSplitter instance
    //   const textSplitter = new RecursiveCharacterTextSplitter({
    //     chunkSize: 1000,
    //   });
    //   console.log("Splitting text into chunks...");
    //   // 7. Split text into chunks (documents)
    //   const chunks = await textSplitter.createDocuments([text]);

    //   const embeddingsArrays = await new OpenAIEmbeddings().embedDocuments(
    //     chunks.map((chunk: { pageContent: string }) =>
    //       chunk.pageContent.replace(/\n/g, " ")
    //     )
    //   );
    //   console.log("embeddings", embeddingsArrays);

    //   let batch = [];
    //   for (let idx = 0; idx < chunks.length; idx++) {
    //     const chunk = chunks[idx];
    //     const vector = {
    //       id: `${txtPath}_${idx}`,
    //       values: embeddingsArrays[idx],
    //       metadata: {
    //         ...chunk.metadata,
    //         loc: JSON.stringify(chunk.metadata.loc),
    //         pageContent: chunk.pageContent,
    //         txtPath: txtPath,
    //       },
    //     };
    //     batch.push(vector);

    //     await pineconeIndex.upsert({
    //       upsertRequest: {
    //         vectors: batch,
    //       },
    //     });
    //   }
    // }

    await db.file.update({
      data: {
        uploadStatus: "SUCCESS",
      },
      where: {
        id: createdFile.id,
      },
    });
  } catch (err) {
    await db.file.update({
      data: {
        uploadStatus: "FAILED",
      },
      where: {
        id: createdFile.id,
      },
    });
  }
};

export const ourFileRouter = {
  freePlanUploader: f({ pdf: { maxFileSize: "4MB" } })
    .middleware(middleware)
    .onUploadComplete(onUploadComplete),
  proPlanUploader: f({ pdf: { maxFileSize: "16MB" } })
    .middleware(middleware)
    .onUploadComplete(onUploadComplete),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
