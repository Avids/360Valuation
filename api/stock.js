import yahooFinance from 'yahoo-finance2';
yahooFinance.setGlobalConfig({ validation: { logErrors: false, logWarns: false }, logger: { disable: true } });

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol is required' });

  const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY;
  const FMP_KEY = process.env.FMP_API_KEY;

  try {
    const s = encodeURIComponent(symbol.toUpperCase());
    let data = null;

    data = await fetchFromYahoo(s);
    if (!data && AV_KEY) data = await fetchFromAlphaVantage(s, AV_KEY);
    if (!data && FMP_KEY) data = await fetchFromFMP(s, FMP_KEY);

    if (!data) return res.status(500).json({ error: 'All data sources failed.' });

    const { 
      name, sector, industry, exchange, marketCap, beta, trailingPE, pbRatio, 
      psRatio, pegRatio, eps, bookValuePS, sharesOut, revenuePerShare, 
      profitMargin, roe, dividendYield, analystTarget, qEarningsGrowth, 
      qRevenueGrowth, netIncomes, revenues, currentPrice 
    } = data;

    if (currentPrice <= 0) return res.status(404).json({ error: 'Unable to determine price.' });

    // ===== GROWTH ESTIMATION =====
    let growthRate = 0;
    if (qEarningsGrowth > 0) growthRate = Math.min(qEarningsGrowth, 0.30);
    else if (qRevenueGrowth > 0) growthRate = Math.min(qRevenueGrowth, 0.25);
    else if (netIncomes.length >= 2) {
      const prev = netIncomes[1];
      if (prev > 0) growthRate = Math.min((netIncomes[0] - prev) / Math.abs(prev), 0.20);
    }
    if (growthRate <= 0) growthRate = 0.05;

    // ===== FIXED 5-YEAR CAGR CALCULATION =====
    // We need the array to be OLDEST -> NEWEST (e.g. [2019, 2023]) to calculate (End/Start)^(1/Years)-1
    let revenueCAGR = null;
    let netIncomeCAGR = null;
    
    if (revenues && revenues.length >= 5) {
      // Reverse array if newest is first (APIs usually return newest first)
      const revSorted = [...revenues].reverse();
      const startRev = revSorted[0];
      const endRev = revSorted[revSorted.length - 1];
      if (startRev > 0 && endRev > 0) {
        revenueCAGR = Math.pow(endRev / startRev, 1 / 4) - 1; // 4 because 5 data points = 4 years of growth
      }
    }

    if (netIncomes && netIncomes.length >= 5) {
      const incSorted = [...netIncomes].reverse();
      const startInc = incSorted[0];
      const endInc = incSorted[incSorted.length - 1];
      if (startInc > 0 && endInc > 0) {
        netIncomeCAGR = Math.pow(endInc / startInc, 1 / 4) - 1;
      }
    }

    // ===== WACC =====
    const riskFree = 0.045;
    const mktPrem  = 0.055;
    const wacc     = Math.max(0.08, Math.min(0.15, riskFree + (beta || 1) * mktPrem));

    // ===== VALUATION MODELS =====
    let grahamNumber = null;
    if (eps > 0 && bookValuePS > 0) grahamNumber = Math.sqrt(22.5 * eps * bookValuePS);

    let epv = null;
    if (netIncomes.length >= 1 && sharesOut > 0) {
      const avgNI = netIncomes.reduce((a, b) => a + b, 0) / netIncomes.length;
      if (avgNI / sharesOut > 0) epv = (avgNI / sharesOut) / wacc;
    }

    let peterLynchValue = null;
    if (eps > 0 && growthRate > 0) peterLynchValue = eps * (1 + growthRate);

    let peterLynchGrowthValue = null;
    if (eps > 0 && growthRate > 0) peterLynchGrowthValue = eps * Math.pow(1 + growthRate, 5);

    let psFairValue = null;
    if (revenuePerShare > 0) {
      let fairPS = profitMargin > 0.20 ? 4.0 : profitMargin > 0.15 ? 3.0 : profitMargin > 0.10 ? 2.0 : profitMargin > 0.05 ? 1.5 : profitMargin > 0 ? 1.0 : 0.8;
      psFairValue = revenuePerShare * fairPS;
    }

    let dcfValue = null;
    if (sharesOut > 0 && netIncomes.length >= 1 && netIncomes[0] > 0) {
      let projFCF = netIncomes[0]; let totalPV = 0;
      for (let i = 1; i <= 5; i++) { projFCF *= (1 + growthRate); totalPV += projFCF / Math.pow(1 + wacc, i); }
      const termVal = (projFCF * 1.03) / (wacc - 0.03);
      totalPV += termVal / Math.pow(1 + wacc, 5);
      dcfValue = totalPV / sharesOut;
    }

    // ===== FIXED GF VALUE CALCULATION =====
    // We NO LONGER delete models just because they are 10x the current price.
    // We only delete models if they are negative, zero, or completely absurd (100x).
    let gfValue = null;
    const wMap = { dcf: 0.35, epv: 0.30, peterLynch: 0.20, graham: 0.15 };
    let wSum = 0, wTotal = 0;

    const isValid = (v) => v !== null && v !== undefined && isFinite(v) && v > 0 && v < currentPrice * 100;

    if (isValid(dcfValue) && dcfValue > 0) { wSum += dcfValue * wMap.dcf; wTotal += wMap.dcf; }
    if (isValid(epv)) { wSum += epv * wMap.epv; wTotal += wMap.epv; }
    if (isValid(peterLynchValue)) { wSum += peterLynchValue * wMap.peterLynch; wTotal += wMap.peterLynch; }
    if (isValid(grahamNumber)) { wSum += grahamNumber * wMap.graham; wTotal += wMap.graham; }

    if (wTotal > 0) gfValue = wSum / wTotal;

    // ===== FIXED MARGIN OF SAFETY =====
    let marginOfSafety = null;
    if (gfValue && gfValue > 0) {
      marginOfSafety = ((gfValue - currentPrice) / gfValue) * 100;
    }

    const r = v => v !== null && v !== undefined && isFinite(v) ? Math.round(v * 100) / 100 : null;

    res.status(200).json({
      currentPrice: r(currentPrice), gfValue: r(gfValue), epv: r(epv),
      peterLynchValue: r(peterLynchValue), peterLynchGrowthValue: r(peterLynchGrowthValue),
      grahamNumber: r(grahamNumber), psFairValue: r(psFairValue), dcfValue: r(dcfValue),
      analystTarget: analystTarget > 0 ? r(analystTarget) : null,
      marginOfSafety: marginOfSafety !== null ? Math.round(marginOfSafety * 10) / 10 : null,
      revenueCAGR: revenueCAGR !== null ? Math.round(revenueCAGR * 1000) / 10 : null,
      netIncomeCAGR: netIncomeCAGR !== null ? Math.round(netIncomeCAGR * 1000) / 10 : null,
      info: {
        name: name || symbol.toUpperCase(), symbol: symbol.toUpperCase(),
        sector: sector || 'N/A', industry: industry || 'N/A', exchange: exchange || 'N/A',
        marketCap: marketCap || 0, peRatio: r(trailingPE), pbRatio: bookValuePS > 0 ? r(currentPrice / bookValuePS) : null,
        psRatio: r(psRatio), pegRatio: pegRatio > 0 ? r(pegRatio) : null, beta: beta || 1,
        roe, profitMargin, eps: r(eps), bookValue: r(bookValuePS), growthRate: r(growthRate), dividendYield,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ==========================================
// DATA FETCHERS
// ==========================================
async function fetchFromYahoo(symbol) {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData', 'incomeStatementHistory']
    });
    if (!result || result.quoteType?.error) return null;

    const price = result.price;
    const stats = result.defaultKeyStatistics;
    const detail = result.summaryDetail;
    const finData = result.financialData;
    
    const currentPrice = price?.regularMarketPrice?.raw || 0;
    if (currentPrice <= 0) return null;

    // Yahoo returns arrays newest-first. We keep it newest-first for the backend math.
    const history = result.incomeStatementHistory?.incomeStatementHistory || [];
    const netIncomes = history.slice(0, 5).map(s => s.totalNetIncome?.raw || 0).filter(v => v !== 0);
    const revenues = history.slice(0, 5).map(s => s.totalRevenue?.raw || 0).filter(v => v !== 0);

    return {
      name: price.longName, sector: price.sector, industry: price.industry, exchange: price.fullExchangeName,
      marketCap: price.marketCap?.raw || 0, beta: stats?.beta?.raw || 1, trailingPE: detail?.trailingPE?.raw || 0,
      psRatio: detail?.priceToSalesTrailing12Months?.raw || 0, pegRatio: stats?.pegRatio?.raw || 0,
      eps: detail?.trailingEps?.raw || 0, bookValuePS: stats?.bookValue?.raw || 0,
      sharesOut: stats?.sharesOutstanding?.raw || 0, revenuePerShare: finData?.revenuePerShare?.raw || 0,
      profitMargin: finData?.profitMargins?.raw || 0, roe: finData?.returnOnEquity?.raw || 0,
      dividendYield: detail?.dividendYield?.raw || 0, analystTarget: finData?.targetMeanPrice?.raw || 0,
      qEarningsGrowth: finData?.earningsGrowth?.raw || 0, qRevenueGrowth: finData?.revenueGrowth?.raw || 0,
      netIncomes, revenues, currentPrice
    };
  } catch (e) {
    console.error('Yahoo Error:', e.message);
    return null;
  }
}

async function fetchFromAlphaVantage(symbol, apiKey) {
  try {
    const fetches = [
      fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`).then(r => r.json()),
      fetch(`https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${symbol}&apikey=${apiKey}`).then(r => r.json()),
    ];
    const results = await Promise.allSettled(fetches);
    const overview = results[0].status === 'fulfilled' ? results[0].value : {};
    const income = results[1].status === 'fulfilled' ? results[1].value : {};
    if (overview['Error Message'] || overview['Note'] || overview['Information']) return null;

    const annualReports = income.annualReports || [];
    // AV returns oldest first. We reverse to match our standard (newest first).
    const reversed = [...annualReports].reverse();
    const netIncomes = reversed.slice(0, 5).map(r => parseFloat(r.netIncome) || 0).filter(v => v !== 0);
    const revenues = reversed.slice(0, 5).map(r => parseFloat(r.totalRevenue) || 0).filter(v => v !== 0);
    
    const eps = parseFloat(overview.EPS) || 0; const bookValuePS = parseFloat(overview.BookValue) || 0;
    const sharesOut = parseFloat(overview.SharesOutstanding) || 0; const trailingPE = parseFloat(overview.TrailingPE) || 0;
    const marketCap = parseFloat(overview.MarketCapitalization) || 0;
    let currentPrice = 0;
    if (marketCap > 0 && sharesOut > 0) currentPrice = marketCap / sharesOut;
    else if (trailingPE > 0 && eps > 0) currentPrice = eps * trailingPE;
    if (currentPrice <= 0) return null;

    return {
      name: overview.Name, sector: overview.Sector, industry: overview.Industry, exchange: overview.Exchange,
      marketCap, beta: parseFloat(overview.Beta) || 1, trailingPE, psRatio: parseFloat(overview.PriceToSalesRatioTTM) || 0,
      pegRatio: parseFloat(overview.PEGRatio) || 0, eps, bookValuePS, sharesOut,
      revenuePerShare: parseFloat(overview.RevenuePerShareTTM) || 0, profitMargin: parseFloat(overview.ProfitMargin) || 0,
      roe: parseFloat(overview.ReturnOnEquityTTM) || 0, dividendYield: parseFloat(overview.DividendYield) || 0,
      analystTarget: parseFloat(overview.AnalystTargetPrice) || 0,
      qEarningsGrowth: parseFloat(overview.QuarterlyEarningsGrowthYOY) || 0,
      qRevenueGrowth: parseFloat(overview.QuarterlyRevenueGrowthYOY) || 0,
      netIncomes, revenues, currentPrice
    };
  } catch (e) { return null; }
}

async function fetchFromFMP(symbol, apiKey) {
  try {
    const [profileRes, incomeRes] = await Promise.all([
      fetch(`https://financialmodelingprep.com/api/v3/profile/${symbol}?apikey=${apiKey}`).then(r => r.json()),
      fetch(`https://financialmodelingprep.com/api/v3/income-statement/${symbol}?limit=5&apikey=${apiKey}`).then(r => r.json())
    ]);
    if (!profileRes || profileRes.length === 0 || profileRes.Error) return null;
    const p = profileRes[0];
    // FMP returns newest first
    const netIncomes = Array.isArray(incomeRes) ? incomeRes.slice(0, 5).map(r => parseFloat(r.netIncome) || 0).filter(v => v !== 0) : [];
    const revenues = Array.isArray(incomeRes) ? incomeRes.slice(0, 5).map(r => parseFloat(r.revenue) || 0).filter(v => v !== 0) : [];
    const currentPrice = parseFloat(p.price) || 0;
    if (currentPrice <= 0) return null;
    const marketCap = parseFloat(p.mktCap) || 0;

    return {
      name: p.companyName, sector: p.sector, industry: p.industry, exchange: p.exchangeShortName,
      marketCap, beta: parseFloat(p.beta) || 1, trailingPE: parseFloat(p.pe) || 0,
      psRatio: parseFloat(p.priceToSalesRatioTTM) || 0, pegRatio: parseFloat(p.pegRatio) || 0,
      eps: parseFloat(p.earningsPerShareBasicTTM) || 0, bookValuePS: parseFloat(p.bookValuePerShare) || 0,
      sharesOut: currentPrice > 0 ? marketCap / currentPrice : 0,
      revenuePerShare: parseFloat(p.revenuePerShareTTM) || 0, profitMargin: parseFloat(p.profitMargin) || 0,
      roe: parseFloat(p.returnOnEquityTTM) || 0, dividendYield: parseFloat(p.dividend) || 0,
      analystTarget: parseFloat(p.analystTargetPrice) || 0,
      qEarningsGrowth: parseFloat(p.quarterlyEarningsGrowthYOY) || 0,
      qRevenueGrowth: parseFloat(p.quarterlyRevenueGrowthYOY) || 0,
      netIncomes, revenues, currentPrice
    };
  } catch (e) { return null; }
}
