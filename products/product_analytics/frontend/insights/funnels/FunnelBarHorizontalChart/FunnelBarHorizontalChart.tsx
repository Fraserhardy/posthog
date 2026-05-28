import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import posthog from 'posthog-js'
import { useMemo, type CSSProperties, type ErrorInfo } from 'react'

import { IconInfinity } from '@posthog/icons'

import { buildTheme } from 'lib/charts/utils/theme'
import { EntityFilterInfo } from 'lib/components/EntityFilterInfo'
import { SeriesGlyph } from 'lib/components/SeriesGlyph'
import { BarChart, type BarChartConfig, type PointClickData, type TooltipContext, useChartLayout } from 'lib/hog-charts'
import { IconTrendingFlat, IconTrendingFlatDown } from 'lib/lemon-ui/icons'
import { Tooltip } from 'lib/lemon-ui/Tooltip'
import { humanFriendlyDuration } from 'lib/utils'
import { DuplicateStepIndicator } from 'scenes/funnels/FunnelBarHorizontal/DuplicateStepIndicator'
import { funnelDataLogic } from 'scenes/funnels/funnelDataLogic'
import { funnelPersonsModalLogic } from 'scenes/funnels/funnelPersonsModalLogic'
import { FunnelStepMore } from 'scenes/funnels/FunnelStepMore'
import {
    formatConvertedCount,
    formatConvertedPercentage,
    formatDroppedOffCount,
    formatDroppedOffPercentage,
    getTooltipTitleForConverted,
    getTooltipTitleForDroppedOff,
} from 'scenes/funnels/funnelUtils'
import { ValueInspectorButton } from 'scenes/funnels/ValueInspectorButton'
import { insightLogic } from 'scenes/insights/insightLogic'
import { getActionFilterFromFunnelStep } from 'scenes/insights/views/Funnels/funnelStepTableUtils'

import { themeLogic } from '~/layout/navigation-3000/themeLogic'
import { groupsModel } from '~/models/groupsModel'
import type { FunnelsFilter } from '~/queries/schema/schema-general'
import { type ChartParams, FunnelStepReference, type FunnelStepWithConversionMetrics, StepOrderValue } from '~/types'

import { FunnelBarHorizontalTooltip } from './FunnelBarHorizontalTooltip'
import { buildFunnelBarHorizontalData, type FunnelBarHorizontalSegmentMeta } from './funnelBarHorizontalTransforms'

const ROW_HEIGHT_PX = 76
// Splits each row 30% header / 40% bar / 30% metadata via d3.scaleBand padding.
const BAR_PADDING = 0.6
const GLYPH_COLUMN_WIDTH_PX = 24
const GLYPH_HEIGHT_PX = 23

function getFillerColor(): string {
    if (typeof document === 'undefined') {
        return 'rgba(0, 0, 0, 0.08)'
    }
    const value = getComputedStyle(document.body).getPropertyValue('--color-border-primary').trim()
    return value || 'rgba(0, 0, 0, 0.08)'
}

const handleChartError = (error: Error, info: ErrorInfo): void => {
    posthog.captureException(error, {
        feature: 'funnels-bar-horizontal-chart',
        componentStack: info.componentStack ?? undefined,
    })
}

export function FunnelBarHorizontalChart({
    showPersonsModal: showPersonsModalProp = true,
    inCardView,
}: ChartParams): JSX.Element | null {
    const { isDarkModeOn } = useValues(themeLogic)
    const theme = useMemo(() => buildTheme(), [isDarkModeOn])
    const fillerColor = useMemo(() => getFillerColor(), [isDarkModeOn])

    const { insightProps } = useValues(insightLogic)
    const {
        visibleStepsWithConversionMetrics,
        aggregationTargetLabel,
        funnelsFilter,
        breakdownFilter,
        isStepOptional,
        getFunnelsColor,
        querySource,
    } = useValues(funnelDataLogic(insightProps))
    const { canOpenPersonModal } = useValues(funnelPersonsModalLogic(insightProps))
    const { openPersonsModalForStep, openPersonsModalForSeries } = useActions(funnelPersonsModalLogic(insightProps))
    const { aggregationLabel } = useValues(groupsModel)

    const steps = visibleStepsWithConversionMetrics
    const stepReference = funnelsFilter?.funnelStepReference || FunnelStepReference.total
    const showPersonsModal = canOpenPersonModal && showPersonsModalProp
    const interactive = showPersonsModal && !inCardView
    const hasOptionalSteps = steps.some((_, stepIndex) => isStepOptional(stepIndex + 1))
    const groupTypeLabel = aggregationLabel(querySource?.aggregation_group_type_index).plural

    const { series, labels } = useMemo(
        () =>
            buildFunnelBarHorizontalData(steps, {
                stepReference,
                breakdownFilter,
                getColor: getFunnelsColor,
                getLabel: (variant) => String(variant.breakdown_value ?? variant.name ?? ''),
                fillerColor,
            }),
        [steps, stepReference, breakdownFilter, getFunnelsColor, fillerColor]
    )

    const chartConfig = useMemo<BarChartConfig>(
        () => ({
            barLayout: 'stacked',
            barCornerRadius: 4,
            axisOrientation: 'horizontal',
            hideXAxis: true,
            hideYAxis: true,
            showGrid: false,
            animateHover: true,
            bandPadding: BAR_PADDING,
            margins: { top: 0, right: 0, bottom: 0, left: GLYPH_COLUMN_WIDTH_PX },
            tooltip: { placement: 'top' },
        }),
        []
    )

    const onPointClick = (clickData: PointClickData<FunnelBarHorizontalSegmentMeta>): void => {
        const meta = clickData.series.meta
        const step = steps[clickData.dataIndex]
        if (!step || !meta) {
            return
        }
        if (meta.isDropOff) {
            openPersonsModalForStep({ step, converted: false })
            return
        }
        if (meta.breakdownIndex != null && step.nested_breakdown?.[meta.breakdownIndex]) {
            openPersonsModalForSeries({
                step,
                series: step.nested_breakdown[meta.breakdownIndex],
                converted: true,
            })
            return
        }
        openPersonsModalForStep({ step, converted: true })
    }

    const renderTooltip = (ctx: TooltipContext<FunnelBarHorizontalSegmentMeta>): JSX.Element | null => (
        <FunnelBarHorizontalTooltip
            context={ctx}
            steps={steps}
            breakdownFilter={breakdownFilter}
            groupTypeLabel={groupTypeLabel}
            showPersonsModal={showPersonsModal}
        />
    )

    if (steps.length === 0) {
        return null
    }

    return (
        <div data-attr="funnel-bar-horizontal" className="w-full p-4">
            {/* eslint-disable-next-line react/forbid-dom-props */}
            <div className="relative flex w-full" style={{ height: steps.length * ROW_HEIGHT_PX }}>
                <BarChart<FunnelBarHorizontalSegmentMeta>
                    series={series}
                    labels={labels}
                    theme={theme}
                    config={chartConfig}
                    tooltip={renderTooltip}
                    onPointClick={interactive ? onPointClick : undefined}
                    onError={handleChartError}
                >
                    <StepDecorations
                        steps={steps}
                        funnelsFilter={funnelsFilter}
                        aggregationTargetLabel={aggregationTargetLabel}
                        isStepOptional={isStepOptional}
                        hasOptionalSteps={hasOptionalSteps}
                        showPersonsModal={showPersonsModal}
                        openPersonsModalForStep={openPersonsModalForStep}
                    />
                </BarChart>
            </div>
        </div>
    )
}

interface StepDecorationsProps {
    steps: FunnelStepWithConversionMetrics[]
    funnelsFilter: FunnelsFilter | null | undefined
    aggregationTargetLabel: { singular: string; plural: string }
    isStepOptional: (step: number) => boolean
    hasOptionalSteps: boolean
    showPersonsModal: boolean
    openPersonsModalForStep: (args: { step: FunnelStepWithConversionMetrics; converted: boolean }) => void
}

function StepDecorations({
    steps,
    funnelsFilter,
    aggregationTargetLabel,
    isStepOptional,
    hasOptionalSteps,
    showPersonsModal,
    openPersonsModalForStep,
}: StepDecorationsProps): JSX.Element {
    const layout = useChartLayout<FunnelBarHorizontalSegmentMeta>()
    const { plotTop, plotLeft, plotHeight, plotWidth } = layout.dimensions
    const rowHeight = steps.length > 0 ? plotHeight / steps.length : 0
    const gapFraction = BAR_PADDING / 2

    return (
        <>
            {steps.map((step, stepIndex) => {
                const rowTop = plotTop + stepIndex * rowHeight
                const isOptional = isStepOptional(stepIndex + 1)
                const isFirstStep = stepIndex === 0
                const isUnordered = funnelsFilter?.funnelOrderType === StepOrderValue.UNORDERED
                const showLineBefore = stepIndex > 0
                const showLineAfter = stepIndex < steps.length - 1
                const gapHeight = rowHeight * gapFraction
                const metadataTop = rowHeight - gapHeight

                const dimRow = isOptional ? 'opacity-60' : ''

                return (
                    <div
                        key={step.order}
                        // eslint-disable-next-line react/forbid-dom-props
                        style={{ position: 'absolute', top: rowTop, left: 0, width: '100%', height: rowHeight }}
                        className="pointer-events-none [&_[role=button]]:pointer-events-auto [&_a]:pointer-events-auto [&_button]:pointer-events-auto"
                    >
                        <div
                            // eslint-disable-next-line react/forbid-dom-props
                            style={{ position: 'absolute', top: 0, left: 0, width: plotLeft, height: rowHeight }}
                            className={clsx('flex flex-col items-center justify-center', isOptional && 'opacity-70')}
                        >
                            {showLineBefore && <SeriesLineBox variant="before" />}
                            {isOptional && hasOptionalSteps && <OptionalConnector />}
                            {isOptional && <OptionalBranchStub />}
                            <div
                                className={clsx('relative z-10 select-none', isOptional && 'ml-6')}
                                // eslint-disable-next-line react/forbid-dom-props
                                style={{ pointerEvents: 'auto' }}
                            >
                                {isUnordered ? (
                                    <SeriesGlyph variant="funnel-step-glyph">
                                        {/* eslint-disable-next-line react/forbid-dom-props */}
                                        <IconInfinity style={{ fill: 'var(--primary_alt)', width: 14 }} />
                                    </SeriesGlyph>
                                ) : (
                                    <SeriesGlyph variant="funnel-step-glyph">{step.order + 1}</SeriesGlyph>
                                )}
                            </div>
                            {showLineAfter && <SeriesLineBox variant="after" />}
                        </div>

                        <header
                            // eslint-disable-next-line react/forbid-dom-props
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: plotLeft,
                                width: plotWidth,
                                height: gapHeight,
                            }}
                            className={clsx('flex flex-wrap items-center justify-between leading-5', dimRow)}
                        >
                            <div className="flex items-center max-w-full grow">
                                <div className="overflow-hidden font-bold break-words whitespace-normal">
                                    {isUnordered ? (
                                        <span>Completed {step.order + 1} steps</span>
                                    ) : (
                                        <EntityFilterInfo filter={getActionFilterFromFunnelStep(step)} allowWrap />
                                    )}
                                </div>
                                {isOptional ? <div className="ml-1 text-xs">(optional)</div> : null}
                                {!isUnordered && stepIndex > 0 && step.action_id === steps[stepIndex - 1].action_id && (
                                    <DuplicateStepIndicator />
                                )}
                                <FunnelStepMore stepIndex={stepIndex} />
                            </div>
                            {step.average_conversion_time && step.average_conversion_time >= Number.EPSILON ? (
                                <div
                                    className="text-secondary text-xs"
                                    title="Average time of conversion from previous step"
                                >
                                    Avg time:{' '}
                                    <b>{humanFriendlyDuration(step.average_conversion_time, { maxUnits: 2 })}</b>
                                </div>
                            ) : null}
                        </header>

                        <div
                            // eslint-disable-next-line react/forbid-dom-props
                            style={{
                                position: 'absolute',
                                top: metadataTop,
                                left: plotLeft,
                                width: plotWidth,
                                height: gapHeight,
                            }}
                            className={clsx('flex flex-wrap items-center gap-2 leading-5', dimRow)}
                        >
                            <Tooltip
                                title={getTooltipTitleForConverted(funnelsFilter, aggregationTargetLabel, stepIndex)}
                                placement="bottom"
                            >
                                <ValueInspectorButton
                                    onClick={
                                        showPersonsModal
                                            ? () => openPersonsModalForStep({ step, converted: true })
                                            : undefined
                                    }
                                >
                                    {/* eslint-disable-next-line react/forbid-dom-props */}
                                    <IconTrendingFlat
                                        style={{ color: 'var(--success)' }}
                                        className="mr-1 text-xl align-bottom"
                                    />
                                    <b>{formatConvertedCount(step, aggregationTargetLabel)}</b>
                                </ValueInspectorButton>{' '}
                                {!isFirstStep && (
                                    <span className="text-secondary grow">
                                        {`(${formatConvertedPercentage(step)}) completed step`}
                                    </span>
                                )}
                            </Tooltip>
                            {!isFirstStep && (
                                <Tooltip
                                    title={getTooltipTitleForDroppedOff(funnelsFilter, aggregationTargetLabel)}
                                    placement="bottom"
                                >
                                    <ValueInspectorButton
                                        onClick={
                                            showPersonsModal
                                                ? () => openPersonsModalForStep({ step, converted: false })
                                                : undefined
                                        }
                                    >
                                        {/* eslint-disable-next-line react/forbid-dom-props */}
                                        <IconTrendingFlatDown
                                            style={{ color: 'var(--danger)' }}
                                            className="mr-1 text-xl align-bottom"
                                        />
                                        <b>{formatDroppedOffCount(step, aggregationTargetLabel)}</b>
                                    </ValueInspectorButton>{' '}
                                    <span className="text-secondary">
                                        {`(${formatDroppedOffPercentage(step)}) dropped off`}
                                    </span>
                                </Tooltip>
                            )}
                        </div>
                    </div>
                )
            })}
        </>
    )
}

function SeriesLineBox({ variant }: { variant: 'before' | 'after' }): JSX.Element {
    const halfGlyph = `${GLYPH_HEIGHT_PX / 2}px`
    const style: CSSProperties =
        variant === 'before'
            ? { top: 0, height: `calc(50% - ${halfGlyph})` }
            : { top: `calc(50% + ${halfGlyph})`, bottom: 0 }
    return (
        <div
            // eslint-disable-next-line react/forbid-dom-props
            style={{
                position: 'absolute',
                left: 'calc(50% - 1px)',
                width: '2px',
                borderRight: '2px solid var(--color-border-primary)',
                opacity: 0.5,
                ...style,
            }}
        />
    )
}

function OptionalConnector(): JSX.Element {
    return (
        <div
            // eslint-disable-next-line react/forbid-dom-props
            style={{
                position: 'absolute',
                top: 0,
                left: 'calc(50% - 1px)',
                width: '2px',
                height: '100%',
                background: 'var(--color-border-primary)',
                opacity: 0.5,
                zIndex: 1,
            }}
        />
    )
}

function OptionalBranchStub(): JSX.Element {
    return (
        <div
            // eslint-disable-next-line react/forbid-dom-props
            style={{
                position: 'absolute',
                top: 'calc(50% - 1px)',
                left: 'calc(50% - 1px)',
                width: '1.5rem',
                height: '2px',
                background: 'var(--color-border-primary)',
                opacity: 0.5,
            }}
        />
    )
}
