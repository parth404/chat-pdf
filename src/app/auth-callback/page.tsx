import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "../_trpc/client";

const page = async () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const origin = searchParams.get("origin");

  const apiResponse = await fetch(`/api/whatever`);

  const { data, isLoading } = trpc.authCallback.useQuery(undefined, {
    onSuccess: ({ success }) => {
      // user is synced to db
      router.push(origin ? `/${origin}` : "/dashboard");
    },
  });
};

export default page;
