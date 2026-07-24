import { useState } from "react";
import { Action, ActionPanel, Color, Icon, Keyboard, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import {
  NamedUsage,
  scanAllUsage,
  totalTokens,
  UsageTotals,
} from "./lib/usage";
import { formatTokenCount } from "./lib/format";

function formatUSD(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * "~$1.23" for a fully priced estimate, "≥$1.23" when some turns used a model
 * with no known price (so the real cost is higher), and "n/a" when nothing
 * here is priced at all.
 */
function costLabel(totals: UsageTotals): string {
  if (!totals.hasUnpriced) return `~${formatUSD(totals.costUSD)}`;
  if (totals.costUSD > 0) return `≥${formatUSD(totals.costUSD)}`;
  return "n/a";
}

function DetailMetadata({ totals }: { totals: UsageTotals }) {
  return (
    <List.Item.Detail.Metadata>
      <List.Item.Detail.Metadata.Label
        title="Input"
        text={totals.input.toLocaleString()}
      />
      <List.Item.Detail.Metadata.Label
        title="Output"
        text={totals.output.toLocaleString()}
      />
      <List.Item.Detail.Metadata.Label
        title="Cache write"
        text={totals.cacheCreation.toLocaleString()}
      />
      <List.Item.Detail.Metadata.Label
        title="Cache read"
        text={totals.cacheRead.toLocaleString()}
      />
      <List.Item.Detail.Metadata.Separator />
      <List.Item.Detail.Metadata.Label
        title="Total tokens"
        text={totalTokens(totals).toLocaleString()}
      />
      <List.Item.Detail.Metadata.Label
        title="Est. cost"
        text={costLabel(totals)}
      />
    </List.Item.Detail.Metadata>
  );
}

function UsageRow({
  id,
  title,
  icon,
  totals,
  showingDetail,
  onToggleDetail,
  onRefresh,
}: {
  id: string;
  title: string;
  icon: Icon;
  totals: UsageTotals;
  showingDetail: boolean;
  onToggleDetail: () => void;
  onRefresh: () => void;
}) {
  const tokens = totalTokens(totals);
  return (
    <List.Item
      id={id}
      icon={{ source: icon, tintColor: Color.SecondaryText }}
      title={title}
      accessories={
        showingDetail
          ? undefined
          : [
              { tag: `${formatTokenCount(tokens)} tok` },
              { text: costLabel(totals) },
            ]
      }
      detail={
        <List.Item.Detail metadata={<DetailMetadata totals={totals} />} />
      }
      actions={
        <ActionPanel>
          <Action
            title={showingDetail ? "Hide Breakdown" : "Show Breakdown"}
            icon={Icon.Sidebar}
            shortcut={{ modifiers: ["cmd"], key: "d" }}
            onAction={onToggleDetail}
          />
          <Action.CopyToClipboard
            title="Copy Figure"
            content={`${title}: ${tokens.toLocaleString()} tokens (${costLabel(totals)})`}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
            onAction={onRefresh}
          />
        </ActionPanel>
      }
    />
  );
}

const OVERVIEW_ICON: Record<string, Icon> = {
  "Last 5 hours": Icon.Clock,
  Today: Icon.Calendar,
  "Last 7 days": Icon.Calendar,
  "Last 30 days": Icon.Calendar,
  "All time": Icon.BarChart,
};

export default function Usage() {
  const {
    data: report,
    isLoading,
    revalidate,
  } = useCachedPromise(() => scanAllUsage(), [], { keepPreviousData: true });
  const [showingDetail, setShowingDetail] = useState(true);

  const toggle = () => setShowingDetail((value) => !value);

  const rowProps = {
    showingDetail,
    onToggleDetail: toggle,
    onRefresh: () => revalidate(),
  };

  const overview = report
    ? ([
        ["Last 5 hours", report.fiveHour],
        ["Today", report.today],
        ["Last 7 days", report.week],
        ["Last 30 days", report.month],
        ["All time", report.all],
      ] as const)
    : [];

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showingDetail && !!report}
      searchBarPlaceholder="Filter usage by period, model, or project…"
    >
      {report ? (
        <>
          <List.Section title="Overview">
            {overview.map(([label, totals]) => (
              <UsageRow
                key={label}
                id={`overview:${label}`}
                title={label}
                icon={OVERVIEW_ICON[label] ?? Icon.BarChart}
                totals={totals}
                {...rowProps}
              />
            ))}
          </List.Section>
          {report.byModel.length > 0 ? (
            <List.Section title="By model (all time)">
              {report.byModel.map((model: NamedUsage) => (
                <UsageRow
                  key={model.key}
                  id={`model:${model.key}`}
                  title={model.label}
                  icon={Icon.Stars}
                  totals={model}
                  {...rowProps}
                />
              ))}
            </List.Section>
          ) : null}
          {report.byProject.length > 0 ? (
            <List.Section title="By project (all time)">
              {report.byProject.slice(0, 12).map((project: NamedUsage) => (
                <UsageRow
                  key={project.key}
                  id={`project:${project.key}`}
                  title={project.label}
                  icon={Icon.Folder}
                  totals={project}
                  {...rowProps}
                />
              ))}
            </List.Section>
          ) : null}
        </>
      ) : (
        <List.EmptyView
          icon={Icon.BarChart}
          title="No usage found"
          description="No Claude Code transcripts with recorded token usage were found."
        />
      )}
    </List>
  );
}
