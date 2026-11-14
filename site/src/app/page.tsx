import {
  ClaudeSection,
  ComingNext,
  ContactCta,
  Facts,
  Features,
  Hero,
  HowItWorks,
  Integrations,
} from "@/components/HomeSections";

export default function Home() {
  return (
    <>
      <Hero />
      <Features />
      <HowItWorks />
      <Integrations />
      <ClaudeSection />
      <ComingNext />
      <Facts />
      <ContactCta />
    </>
  );
}
