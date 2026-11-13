import BaristaBoard from "@/components/BaristaBoard";

export default function Home() {
  return <BaristaBoard cafeName={process.env.NEXT_PUBLIC_CAFE_NAME || "The Coffee Bar"} />;
}
