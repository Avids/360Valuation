export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Stock symbol is required' });

  const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY;
  const FMP_KEY = process.env.FMP_API_KEY;

  if (!AV_KEY && !FMP_KEY) {
    return res.status(500).json({ error: 'No API keys configured. Set ALPHA_VANTAGE_API_KEY or FMP_API_KEY in Vercel.' });
  }

  try {
    const s = encodeURIComponent(symbol.toUpperCase());
    let data = null;

    // --- STRATEGY 1: TRY ALPHA VANTAGE ---
    if (AV_KEY) {
      data = await fetchFromAlphaVantage(s, AV_KEY);
    }

    // --- STRATEGY 2: FALLBACK TO FMP ---
    if (!data && FMP_KEY) {
      data = await fetchFromFMP(s, FMP_KEY);
    }

    if (!data) {
      return res.status(429).json({ 
        error: 'All free API rate limits reached. Please wait a few minutes or add an FMP_API_KEY to Vercel.' 
      });
    }

    // ===== EXTRACT NORMALIZED DATA =====
    const { 
      name, sector, industry, exchange, marketCap, beta, trailingPE, pbRatio, 
      psRatio, pegRatio, eps, bookValuePS, sharesOut, revenuePerShare, 
      profitMargin, roe, dividendYield, analystTarget, qEarningsGrowth, 
      qRevenueGrowth, netIncomes, currentPrice 
    } = data;

    if (currentPrice <= 0) {
      return res.status(404).json({ error: 'Unable to determine current price for this stock.' });
    }

    // ===== GROWTH RATE ESTIMATION =====
    let growthRate = 0;
    if (qEarningsGrowth > 0) {
      growthRate = Math.min(qEarningsGrowth, 0.30);
    } else if (qRevenueGrowth > 0) {
      growthRate = Math.min(qRevenueGrowth, 0.25);
    } else if (netIncomes.length >= 2) {
      const prev = netIncomes[1];
      if (prev > 0) growthRate = Math.min((netIncomes[0] - prev) / Math.abs(prev), 0.20);
    }
    if (growthRate <= 0) growthRate = 0.05;

    // ===== WACC ESTIMATION =====
    const riskFree = 0.045;
    const mktPrem  = 0.055;
    const wacc     = Math.max(0.08, Math.min(0.15, riskFree + (beta || 1) * mktPrem));

    // ===== VALUATION MODELS =====
    
    // 1. Graham Number
    let grahamNumber = null;
    if (eps > 0 && bookValuePS > 0) {
      grahamNumber = Math.sqrt(22.5 * eps * bookValuePS);
    }

    // 2. Earnings Power Value
    let epv = null;
    if (netIncomes.length >= 1 && sharesOut > 0) {
      const avgNI  = netIncomes.reduce((a, b) => a + b, 0) / netIncomes.length;
      const avgEPS = avgNI / sharesOut;
      if (avgEPS > 0) epv = avgEPS / wacc;
    }

    // 3. Peter Lynch Fair Value
    let peterLynchValue = null;
    if (eps > 0 && growthRate > 0) {
      peterLynchValue = eps * (1 + growthRate);
    }

    // 4. P/S Fair Value
    let psFairValue = null;
    if (revenuePerShare > 0) {
      let fairPS;
      if (profitMargin > 0.20)      fairPS = 4.0;
      else if (profitMargin > 0.15) fairPS = 3.0;
      else if (profitMargin > 0.10) fairPS = 2.0;
      else if (profitMargin > 0.05) fairPS = 1.5;
      else if (profitMargin > 0)    fairPS = 1.0;
      else                          fairPS = 0.8;
      psFairValue = revenuePerShare * fairPS;
    }

    // 5. DCF Fair Value
    let dcfValue = null;
    if (sharesOut > 0 && netIncomes.length >= 1 && netIncomes[0] > 0) {
      const baseFCF = netIncomes[0];
      let projFCF = baseFCF;
      let totalPV = 0;
      const projYears = 5;
      const termGrowth = 0.03;

      for (let i = 1; i <= projYears; i++) {
        projFCF *= (1 + growthRate);
        totalPV += projFCF / Math.pow(1 + wacc, i);
      }
      const termVal = (projFCF * (1 + termGrowth)) / (wacc - termGrowth);
      totalPV += termVal / Math.pow(1 + wacc, projYears);
      dcfValue = totalPV / sharesOut;
    }

    // 6. GF Value
    let gfValue = null;
    const wMap = { dcf: 0.35, epv: 0.30, peterLynch: 0.20, graham: 0.15 };
    let wSum = 0, wTotal = 0;

    if (dcfValue && dcfValue > 0 && dcfValue < currentPrice * 10) { wSum += dcfValue * wMap.dcf; wTotal += wMap.dcf; }
    if (epv && epv > 0 && epv < currentPrice * 10)                { wSum += epv * wMap.epv; wTotal += wMap.epv; }
    if (peterLynchValue && peterLynchValue > 0 && peterLynchValue < currentPrice * 10) { wSum += peterLynchValue * wMap.peterLynch; wTotal += wMap.peterLynch; }
    if (grahamNumber && grahamNumber > 0 && grahamNumber < currentPrice * 10)           { wSum += grahamNumber * wMap.graham; wTotal += wMap.graham; }

    if (wTotal > 0) gfValue = wSum / wTotal;

    // Margin of Safety
    let marginOfSafety = null;
    if (gfValue && gfValue > 0) {
      marginOfSafety = ((gfValue - currentPrice) / gfValue) * 100;
    }

    const r = v => v !== null && v !== undefined && isFinite(v) ? Math.round(v * 100) / 100 : null;

    res.status(200).json({
      currentPrice:     r(currentPrice),
      gfValue:          r(gfValue),
      epv:              r(epv),
      peterLynchValue:  r(peterLynchValue),
      grahamNumber:     r(grahamNumber),
      psFairValue:      r(psFairValue),
      dcfValue:         r(dcfValue),
      analystTarget:    analystTarget > 0 ? r(analystTarget) : null,
      marginOfSafety:   marginOfSafety !== null ? Math.round(marginOfSafety * 10) / 10 : null,
      info: {
        name:           name || symbol.toUpperCase(),
        symbol:         symbol.toUpperCase(),
        sector:         sector || 'N/A',
        industry:       industry || 'N/A',
        exchange:       exchange || 'N/A',
        marketCap:      marketCap || 0,
        peRatio:        r(trailingPE),
        pbRatio:        bookValuePS > 0 ? r(currentPrice / bookValuePS) : null,
        psRatio:        r(psRatio),
        pegRatio:       pegRatio > 0 ? r(pegRatio) : null,
        beta:           beta || 1,
        roe:            roe,
        profitMargin:   profitMargin,
        eps:            r(eps),
        bookValue:      r(bookValuePS),
        growthRate:     r(growthRate),
        dividendYield:  dividendYield,
      }
    });
  } catch (err) {
    console.error('Stock API Error:', err);
    res.status(500).json({ error: 'Failed to fetch stock data: ' + err.message });
  }
}

// ==========================================
// DATA FETCHING & NORMALIZATION FUNCTIONS
// ==========================================

async function fetchFromAlphaVantage(symbol, apiKey) {
  try {
    const fetches = [
      fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`).then(r => r.json()),
      fetch(`https://www.alphavantage.co/query?function=INCOME_STATEMENT&symbol=${symbol}&apikey=${apiKey}`).then(r => r.json()),
      fetch(`https://www.alphavantage.co/query?function=BALANCE_SHEET&symbol=${symbol}&apikey=${apiKey}`).then(r => r.json()),
    ];

    const results = await Promise.allSettled(fetches);
    const overview = results[0].status === 'fulfilled' ? results[0].value : {};
    const income   = results[1].status === 'fulfilled' ? results[1].value : {};
    const balance  = results[2].status === 'fulfilled' ? results[2].value : {};

    // Check for AV Rate Limits / Errors
    if (overview['Error Message']) return null;
    if (overview['Note'] || overview['Information']) {
      console.log('Alpha Vantage rate limit hit. Switching to FMP...');
      return null; // Triggers fallback
    }

    const eps              = parseFloat(overview.EPS) || 0;
    const bookValuePS      = parseFloat(overview.BookValue) || 0;
    const sharesOut        = parseFloat(overview.SharesOutstanding) || 0;
    const trailingPE       = parseFloat(overview.TrailingPE) || 0;
    const psRatio          = parseFloat(overview.PriceToSalesRatioTTM) || 0;
    const pegRatio         = parseFloat(overview.PEGRatio) || 0;
    const revenuePerShare  = parseFloat(overview.RevenuePerShareTTM) || 0;
    const profitMargin     = parseFloat(overview.ProfitMargin) || 0;
    const roe              = parseFloat(overview.ReturnOnEquityTTM) || 0;
    const beta             = parseFloat(overview.Beta) || 1;
    const analystTarget    = parseFloat(overview.AnalystTargetPrice) || 0;
    const qEarningsGrowth  = parseFloat(overview.QuarterlyEarningsGrowthYOY) || 0;
    const qRevenueGrowth   = parseFloat(overview.QuarterlyRevenueGrowthYOY) || 0;
    const marketCap        = parseFloat(overview.MarketCapitalization) || 0;
    const dividendYield    = parseFloat(overview.DividendYield) || 0;

    const annualReports = income.annualReports || [];
    const netIncomes    = annualReports.slice(0, 5).map(r => parseFloat(r.netIncome) || 0).filter(v => v !== 0);

    let currentPrice = 0;
    if (marketCap > 0 && sharesOut > 0) currentPrice = marketCap / sharesOut;
    else if (trailingPE > 0 && eps > 0) currentPrice = eps * trailingPE;

    if (currentPrice <= 0) return null;

    return {
      name: overview.Name, sector: overview.Sector, industry: overview.Industry, exchange: overview.Exchange,
      marketCap, beta, trailingPE, psRatio, pegRatio, eps, bookValuePS, sharesOut,
      revenuePerShare, profitMargin, roe, dividendYield, analystTarget,
      qEarningsGrowth, qRevenueGrowth, netIncomes, currentPrice
    };
  } catch (e) {
    return null;
  }
}

async function fetchFromFMP(symbol, apiKey) {
  try {
    // FMP Profile gives almost everything in one request. Free tier allows 250/day.
    const profileRes = await fetch(`https://financialmodelingprep.com/api/v3/profile/${symbol}?apikey=${apiKey}`);
    const profileData = await profileRes.json();
    
    if (!profileData || profileData.length === 0 || profileData.Error) return null;

    const p = profileData[0];
    
    // We still need income statement for Net Income history (for DCF and EPV math)
    const incomeRes = await fetch(`https://financialmodelingprep.com/api/v3/income-statement/${symbol}?limit=5&apikey=${apiKey}`);
    const incomeData = await incomeRes.json();
    
    const netIncomes = Array.isArray(incomeData) 
      ? incomeData.slice(0, 5).map(r => parseFloat(r.netIncome) || 0).filter(v => v !== 0) 
      : [];

    // FMP gives price directly
    const currentPrice = parseFloat(p.price) || 0;
    if (currentPrice <= 0) return null;

    const marketCap = parseFloat(p.mktCap) || 0;
    const sharesOut = currentPrice > 0 ? marketCap / currentPrice : 0;

    return {
      name: p.companyName,
      sector: p.sector,
      industry: p.industry,
      exchange: p.exchangeShortName,
      marketCap,
      beta: parseFloat(p.beta) || 1,
      trailingPE: parseFloat(p.pe) || 0,
      psRatio: parseFloat(p.priceToSalesRatioTTM) || 0,
      pegRatio: parseFloat(p.pegRatio) || 0,
      eps: parseFloat(p.earningsPerShareBasicTTM) || 0,
      bookValuePS: parseFloat(p.bookValuePerShare) || 0,
      sharesOut,
      revenuePerShare: parseFloat(p.revenuePerShareTTM) || 0,
      profitMargin: parseFloat(p.profitMargin) || 0,
      roe: parseFloat(p.returnOnEquityTTM) || 0,
      dividendYield: parseFloat(p.dividend) || 0, // FMP 'dividend' is actually the yield percentage
      analystTarget: parseFloat(p.analystTargetPrice) || 0,
      qEarningsGrowth: parseFloat(p.quarterlyEarningsGrowthYOY) || 0,
      qRevenueGrowth: parseFloat(p.quarterlyRevenueGrowthYOY) || 0,
      netIncomes,
      currentPrice
    };
  } catch (e) {
    console.error('FMP Fetch Error:', e);
    return null;
  }
}
