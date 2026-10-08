// "SanjeevniOS" written out in a sentence or heading, in the brand colours:
// the name in the surrounding text colour, "OS" in the moving gradient.
export default function BrandName({ className = '' }: { className?: string }) {
  return (
    <span className={className}>
      Sanjeevni<span className="os-grad">OS</span>
    </span>
  );
}
